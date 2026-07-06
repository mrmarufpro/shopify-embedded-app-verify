# shopify-embedded-app-verify — Design Specification

**Date:** 2026-07-06
**Status:** Approved pending review
**Repo:** standalone Claude Code plugin + marketplace (planned: `mrmarufpro/shopify-embedded-app-verify`)

## 1. Problem

Agentic Shopify app development needs a closed verification loop: the agent changes code, opens the embedded app inside the real Shopify admin, interacts with it, and checks the result against the plan — repeating until it matches. Blockers today:

- The Claude Chrome extension is unavailable to Claude API users (subscription-only).
- A default Playwright MCP launch opens an isolated, unauthenticated Chromium — the Shopify admin redirects to login and the loop dies there.
- Every developer uses a different daily browser (Comet, Chrome, Chromium), so authentication strategy must be per-developer.

## 2. Goals

1. Agent can open the embedded Shopify admin app **authenticated**, with no login step during the loop.
2. Agent interacts with the app (click, type, snapshot, screenshot) inside the admin iframe.
3. Verification runs in a **separate browser window** so the developer's current work is not disturbed.
4. Per-developer browser configuration; per-project app/store configuration.
5. Distributed as a Claude Code plugin installable from a GitHub marketplace repo.
6. Generic: works for any Shopify embedded app project, not just StoreSEO.

**Non-goals:** driving non-Chromium browsers (Safari, Firefox); theme-extension preview verification; CI/headless-server operation (a human-owned browser session is assumed).

## 3. Proven mechanics (POC, 2026-07-06)

All core mechanics were proven end-to-end on macOS against a live dev store before this spec:

| # | Claim | Evidence |
|---|-------|----------|
| 1 | Comet (Chromium 149 fork) accepts `--remote-debugging-port=9222` **on its default profile** — it does not inherit Chrome 136+'s CDP-on-default-profile block | `curl localhost:9222/json/version` returned browser metadata after relaunch |
| 2 | Playwright `connectOverCDP` attaches to the live browser and inherits the developer's logged-in Shopify session | Navigation to `admin.shopify.com` landed on the store dashboard, no login redirect |
| 3 | The embedded app iframe (`iframe[name="app-iframe"]`) is pierceable via `frameLocator` — content readable, therefore clickable/typeable | Read StoreSEO dashboard text through the iframe while served from a live `shopify app dev` cloudflared tunnel |
| 4 | `Target.createTarget {newWindow: true}` (raw CDP) opens a **separate window** in the same authenticated browser; the developer's windows/tabs are untouched | Verify window opened, app loaded and pierced inside it, window closed cleanly |
| 5 | A dedicated `--user-data-dir` profile persists cookies + localStorage across full browser quit/relaunch | Marker cookie and localStorage survived relaunch (dedicated-profile fallback mode) |

Known constraint: **Chrome/Edge 136+ silently ignore `--remote-debugging-port` on the default profile.** Chrome users therefore cannot attach to their daily session; they use a dedicated profile (mode `profile`, one-time login, weeks-persistent).

## 4. Architecture

### 4.1 Plugin layout

```
shopify-embedded-app-verify/
├── .claude-plugin/
│   └── plugin.json            # manifest + userConfig schema
├── .mcp.json                  # bundled Playwright MCP in CDP-attach mode
├── skills/
│   ├── setup/
│   │   └── SKILL.md           # /shopify-embedded-app-verify:setup — first-run wizard
│   └── verify/
│       └── SKILL.md           # /shopify-embedded-app-verify:verify — the loop
├── scripts/
│   └── ensure-browser.mjs     # cross-platform preflight (Node, zero npm deps)
├── docs/specs/                # this spec
└── README.md
```

Marketplace: same repo doubles as marketplace — a marketplace manifest (`marketplace.json`, placed per current Claude Code docs) lists this plugin with a relative source path. Install flow:

```
claude plugin marketplace add mrmarufpro/shopify-embedded-app-verify
/plugin install shopify-embedded-app-verify@shopify-embedded-app-verify
```

### 4.2 Configuration model — three layers

**Layer 1 — per-developer (`userConfig` in plugin.json).** Prompted by Claude Code when the plugin is enabled; stored machine-locally in the user's `~/.claude/settings.json` `pluginConfigs` (never committed, not team-shared).

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `browser` | string enum + custom | `chrome` | `comet` \| `chrome` \| `chromium` \| absolute binary path |
| `mode` | string enum | `profile` | `attach` (use daily browser's live session) \| `profile` (dedicated automation profile) |
| `cdp_port` | string | `9222` | CDP debug port |

Values reach the plugin via `${user_config.*}` substitution — in the MCP config AND in skill content, where the skills pass them to `ensure-browser.mjs` as CLI flags. `CLAUDE_PLUGIN_OPTION_*` env vars exist but are only exported to plugin subprocesses (hooks, MCP servers), never to skill-issued Bash commands, so scripts must not rely on them as the primary channel (the script keeps them as a fallback for hook callers).

**Layer 2 — per-project.** Written by the setup skill into the project's `.claude/shopify-verify.json` (developer may gitignore or commit — app handle and store domain are not secrets):

```json
{
  "appHandle": "storeseo-dev",
  "storeDomain": "store-seo-app-test",
  "iframeSelector": "iframe[name=\"app-iframe\"]"
}
```

`appHandle` is auto-derived from `shopify.app.toml` (`handle` key); `storeDomain` is asked once. `iframeSelector` defaults and rarely changes.

**Layer 3 — session state.** Nothing persisted; the verify window is created per loop run and closed (or intentionally left open) at the end.

### 4.3 MCP server (`.mcp.json`)

```json
{
  "mcpServers": {
    "shopify-verify-browser": {
      "command": "npx",
      "args": [
        "-y", "@playwright/mcp@latest",
        "--cdp-endpoint", "http://127.0.0.1:${user_config.cdp_port}",
        "--output-dir", "${CLAUDE_PLUGIN_ROOT}/.mcp-output",
        "--output-max-size", "50000000"
      ]
    }
  }
}
```

- Attaches to whatever Chromium listens on the port — same MCP config for both modes; the mode only changes how the browser was launched.
- `--output-dir` keeps the server's working artifacts (accessibility-snapshot `.yml` files, screenshots) inside the plugin's own directory: without it they land in `<project cwd>/.playwright-mcp/` and pollute the developer's git status. `--output-max-size` evicts old artifacts past ~50 MB.
- Connection is lazy (first tool call), so a dead port at session start is harmless; the verify skill's preflight fixes the port before any tool call.
- Coexists with any personal isolated Playwright MCP the developer already has.

### 4.4 Browser modes

**`attach`** — developer's daily browser, existing sessions.
- Preflight: probe `http://localhost:<port>/json/version`. If dead: graceful quit, wait for process exit, relaunch with `--remote-debugging-port=<port>` (tabs restore via the browser's session restore).
- Works on: Comet (proven). Any Chromium fork that hasn't adopted Chrome's 136+ restriction.
- Setup skill verifies attach actually works (probe after relaunch); if the port never opens, it tells the developer this browser blocks CDP on the default profile and switches them to `profile` mode.

**`profile`** — dedicated automation profile, any Chromium.
- Launch: `<binary> --user-data-dir=<home>/.claude-browser-profiles/shopify-verify-<browser> --no-first-run --no-default-browser-check --remote-debugging-port=<port>` (non-default dir ⇒ CDP allowed even on Chrome 136+). The profile dir is per-browser: Chromium forks sharing one user-data-dir leak preferences into each other (Comet's perplexity.ai start page appearing in Chrome) and risk profile-version corruption — the cost is one Shopify login per browser instead of one per plugin.
- First run: setup skill opens the profile browser and waits while the developer logs into the Shopify admin once. Session persists on disk across reboots (weeks, until Shopify expires it).
- Later runs: launch if not running, no login.

### 4.5 `ensure-browser.mjs` (preflight script)

Node ESM script, zero npm dependencies (Node is already required — the bundled MCP server runs via `npx`). One script for macOS, Windows, and Linux. Responsibilities:

1. Resolve config: CLI flags `--browser` / `--mode` / `--port` (passed by the skills from `${user_config.*}` substitution) > `CLAUDE_PLUGIN_OPTION_*` env vars (plugin-subprocess callers only) > defaults `chrome` / `profile` / `9222`. Blank values and unsubstituted `${user_config...}` literals count as unset.
2. Resolve the browser binary per OS (custom absolute path always passes through):

   | Browser | macOS | Windows | Linux |
   |---------|-------|---------|-------|
   | chrome | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` | `%ProgramFiles%\Google\Chrome\Application\chrome.exe` (+ x86/LocalAppData variants) | `google-chrome`, `google-chrome-stable` on PATH |
   | chromium | `/Applications/Chromium.app/...` | `%LocalAppData%\Chromium\Application\chrome.exe` | `chromium`, `chromium-browser` on PATH |
   | comet | `/Applications/Comet.app/Contents/MacOS/Comet` | `%LocalAppData%\Perplexity\Comet\Application\comet.exe` (best-effort) | not distributed — custom path |
   | brave / edge | analogous well-known install paths | analogous | analogous |

3. If the CDP port is already alive → identify the owning process (lsof/ps on macOS+Linux, Get-NetTCPConnection/Win32_Process on Windows) and classify it against the configured browser:
   - launched by this plugin (command line contains the automation profile dir) and binary matches → reuse, exit 0
   - launched by this plugin but binary differs (config changed since) → quit that process (safe — it is ours), fall through to a fresh launch
   - foreign process, binary matches config → reuse, exit 0 (attach-mode happy path)
   - foreign process, binary differs → exit `BROWSER_MISMATCH`; never touch the developer's own browser
   - owner unidentifiable → reuse with a warning (previous behavior)
4. Otherwise launch/relaunch per mode (§4.4). Graceful quit per OS: macOS `osascript -e 'quit app'`; Linux `SIGTERM` to the browser process; Windows `taskkill /IM <exe>` **without** `/F` (sends WM_CLOSE). All three preserve session restore.
5. Poll the port up to ~20 s; exit non-zero with a machine-readable reason (`BROWSER_NOT_FOUND`, `CDP_BLOCKED_DEFAULT_PROFILE`, `PORT_TIMEOUT`, `BROWSER_MISMATCH`) plus a human-readable message.

The verify skill runs this (`node ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-browser.mjs`) before touching MCP tools and surfaces script errors verbatim.

### 4.6 Verify window

To avoid disturbing the developer's open tabs, all verification happens in a dedicated window:

- Created through the MCP server itself via `browser_run_code_unsafe` executing `page.context().newCDPSession(page)` → `Target.createTarget({url, newWindow: true})` — no bundled Node dependencies. `url` is the actual destination (verification URL / admin dashboard), so the window opens directly on it with no `about:blank` hop. The returned `targetId` is saved for cleanup.
- The skill then selects the newly added tab (`browser_tabs` — the entry absent from the pre-creation list; not the first URL match, since the developer may have the same admin page open) and performs every subsequent `browser_navigate` / `browser_click` / `browser_snapshot` in it.
- Loop end: window closed by default via `Target.closeTarget({targetId})` with the saved id — never `browser_close`/close-by-index, which act on the MCP's current tab and misfire among the developer's tabs. `keep the window open` in the user's request leaves it for manual inspection.

### 4.7 The verify loop (skill `/shopify-embedded-app-verify:verify`)

Inputs: the plan/expected behavior (from conversation context or an explicit argument).

```
1. Preflight
   a. ensure-browser.mjs                     → CDP alive
   b. project config exists?                 → else run setup flow inline
   c. dev server + tunnel reachable?         → probe application_url from shopify.app.toml;
                                               if down, tell the user to start their dev server
                                               (never auto-start — running the app is the user's job)
2. Open verify window (§4.6) directly at
   https://admin.shopify.com/store/<storeDomain>/apps/<appHandle>/<page-path>
3. On later loop iterations: reload / re-navigate the same verify tab
4. Wait for the app iframe; pierce with the configured iframe selector
5. Interact per plan: snapshot → click/type/select → wait
6. Capture evidence: accessibility snapshot + screenshot
7. Assert vs plan
   - PASS → report with evidence, close window (unless asked to keep), done
   - FAIL → report mismatch precisely, return to code, fix, goto 3
8. Loop guard: after 3 consecutive failed iterations on the same assertion,
   stop and report instead of thrashing
9. Cleanup: delete every screenshot taken during the run once the report is
   delivered. If the user asked to keep them ("keep the screenshots"), move
   them to <project>/.claude/verify-screenshots/<timestamp>/ instead and say so.
```

Screenshots are working evidence, not artifacts: they live in a temp directory
during the run, are read into the report, then deleted by default.

### 4.8 Setup skill (`/shopify-embedded-app-verify:setup`)

One-time per developer per project:

1. Echo the resolved userConfig (browser/mode/port); tell the developer how to change it (`/plugin` → configure).
2. Run `ensure-browser.mjs`; on `profile` mode first run, pause: "log into the Shopify admin in the window that just opened, then continue."
3. Open the verify window (§4.6), navigate it to `admin.shopify.com`, assert no redirect to `accounts.shopify.com` login. Never open tabs in the developer's own windows.
4. Derive `appHandle` from `shopify.app.toml`; ask for `storeDomain`; write `.claude/shopify-verify.json`.
5. Smoke test in the same verify window: embedded app page → pierce iframe → screenshot → report → close the window via `Target.closeTarget`.

## 5. Error handling

| Failure | Detection | Response |
|---------|-----------|----------|
| CDP port dead | preflight probe | relaunch per mode; hard error with reason if still dead |
| Browser blocks CDP on default profile (Chrome 136+, attach mode) | port never opens after relaunch with flag | explain constraint, instruct switch to `profile` mode |
| Shopify session expired | URL redirects to `accounts.shopify.com` | attach: ask developer to log in in their browser; profile: open profile window, pause for one-time login |
| Dev server/tunnel down | HTTP probe of `application_url` fails / iframe shows tunnel error | ask developer to start their dev server; never auto-start |
| Iframe never appears | `frameLocator` timeout | screenshot the admin page, report what actually rendered (404, install prompt, error banner) |
| App not installed on store | admin 404 page | report; suggest install link from dev server output |
| Repeated assertion failure | 3 consecutive fails on same check | stop loop, report evidence, hand control back |

## 6. Security considerations

- An open CDP port allows **any local process** to control the browser and all its sessions. Localhost-only, but real. README and setup skill state this plainly; developers quit/relaunch the browser normally to close the port. `profile` mode confines exposure to the automation profile's sessions only.
- `browser_run_code_unsafe` is used solely for the fixed window-creation and window-close snippets.
- No credentials are ever stored by the plugin; sessions live in the browser profile as with normal use.

## 7. Testing strategy

- **Script tests:** `node --test` unit tests for `ensure-browser.mjs` pure logic (binary resolution per OS, port probe short-circuit, error codes) — no live browser needed; runs in CI on ubuntu/macos/windows runners.
- **Manual acceptance matrix (README checklist):** attach+Comet, profile+Chrome, each: setup → verify smoke test.
- **Dogfood:** first real consumer is the StoreSEO repo; acceptance = agent completes one full edit→verify→fix cycle on a real UI change.

## 8. Out of scope (v1)

- Multi-store parallel verification.
- Video/trace recording of verify runs.
- Auto-starting the project dev server.
- Firefox/WebKit.

## 9. Open questions

None — all design decisions resolved in brainstorming 2026-07-06.
