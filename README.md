# Shopify Embedded App Verify

A Claude Code plugin that closes the verification loop for agentic Shopify
embedded-app development: the agent changes code, then drives your **real,
authenticated** Shopify admin — in your own browser — to check the result
against the plan, repeating until it matches.

## 1. What it is

Agentic Shopify app development needs a way for the agent to actually look at
what it built. Two obvious options don't work: the Claude Chrome extension is
subscription-only and unavailable to Claude API users, and a vanilla
Playwright MCP launch opens an isolated, unauthenticated Chromium — the
Shopify admin just redirects it to login and the loop dies there. This plugin
solves that by attaching (via the Chrome DevTools Protocol) to a Chromium
browser that already has a logged-in Shopify session, opening the embedded
app inside a dedicated verify window so your own tabs are never touched, and
piercing the app's iframe to click, type, snapshot, and screenshot it like a
real reviewer would — then reporting pass/fail against the plan and looping
on a fix if it fails.

## 2. Install

```bash
claude plugin marketplace add mrmarufpro/shopify-embedded-app-verify
claude plugin install shopify-embedded-app-verify@shopify-embedded-app-verify
```

## 3. Configure

Claude Code prompts for these the first time the plugin is enabled, and
stores them machine-locally (not team-shared, not committed) in your
`~/.claude/settings.json`. Change them any time via `/plugin` →
shopify-embedded-app-verify → configure.

| Key | Default | Meaning |
|-----|---------|---------|
| `browser` | `chrome` | `comet` \| `chrome` \| `chromium` \| `brave` \| `edge` — or an absolute path to any Chromium-based browser binary |
| `mode` | `profile` | `attach` = your daily browser + its logged-in session (browser must allow CDP on the default profile, e.g. Comet). `profile` = dedicated automation profile, one-time Shopify login (works with every Chromium; required for Chrome/Edge). |
| `cdp_port` | `9222` | Local Chrome DevTools Protocol port the browser listens on |

**Which mode should you pick?**

- **`attach`** — for Comet-class browsers only. It reuses your daily browser's
  live, logged-in session, so there's nothing to log into. It does **not**
  work on current Chrome or Edge: as of version 136, Chrome and Edge silently
  ignore `--remote-debugging-port` on the default profile as a security
  hardening measure (see Chrome's [remote debugging port
  note](https://developer.chrome.com/blog/remote-debugging-port)). If you're
  on Chrome or Edge, `attach` mode will never open a CDP port and the
  setup-embedded-app-verify skill will tell you to switch to `profile`.
- **`profile`** — works with any Chromium-based browser, including Chrome and
  Edge. It launches (or reuses) a dedicated automation profile at
  `~/.claude-browser-profiles/shopify-verify`, isolated from your normal
  browsing profile. You log into the Shopify admin in that profile once; the
  session then persists on disk for weeks, across reboots, until Shopify
  itself expires it.

## 4. Per-project setup

Run once per project:

```
/shopify-embedded-app-verify:setup-embedded-app-verify
```

This shows your resolved developer config, makes sure a CDP-enabled browser
is running (pausing for a one-time Shopify login on `profile` mode's first
run), derives the app handle from `shopify.app.toml`, asks for your dev
store's subdomain, and writes `.claude/shopify-verify.json`:

```json
{
  "appHandle": "storeseo-dev",
  "storeDomain": "store-seo-app-test",
  "iframeSelector": "iframe[name=\"app-iframe\"]"
}
```

`appHandle` and `iframeSelector` rarely change by hand; `storeDomain` is the
subdomain of your dev store (the part before `.myshopify.com`).

**Your dev server must already be running** (`shopify app dev`, or your
project's equivalent) before you set up or verify. The plugin never starts
it for you — running the app is your job; verifying it is the agent's.

## 5. Usage

Just ask, after making a change: "verify that the settings page save button
works now" or "check that the new discount banner shows up." The agent runs
the loop: preflight the browser and dev server, open a separate verify
window (your own tabs are never touched), navigate to the embedded app,
pierce its iframe, interact per the plan, capture an accessibility snapshot
plus screenshots as evidence, and compare the result against what was
expected. On a mismatch it reports the exact difference, fixes the code, and
re-verifies — up to 3 consecutive failures on the same assertion before it
stops and hands control back instead of thrashing.

Screenshots taken during a run are working evidence, not artifacts: they are
deleted once the report is delivered. Say "keep the screenshots" and they're
moved to `<project>/.claude/verify-screenshots/<timestamp>/` instead.

## 6. Security

- An open CDP port allows **any local process** to control the browser and
  all its sessions. Localhost-only, but real. README and the setup-embedded-app-verify skill state
  this plainly; developers quit/relaunch the browser normally to close the
  port. `profile` mode confines exposure to the automation profile's
  sessions only.
- `browser_run_code_unsafe` is used solely for the fixed window-creation
  snippet.
- No credentials are ever stored by the plugin; sessions live in the browser
  profile as with normal use.

## 7. Platform support

| Platform | Status |
|----------|--------|
| macOS | Proven live end-to-end against a real dev store (see `docs/specs/2026-07-06-shopify-embedded-app-verify-design.md` §3) |
| Windows | `ensure-browser.mjs`'s binary-resolution, launch, and quit logic is unit-tested and runs in CI on `windows-latest`; not yet verified against a live browser/Shopify session |
| Linux | Same as Windows — unit-tested paths, CI-covered on `ubuntu-latest`; not yet verified live |

Community verification on Windows and Linux is welcome — if you try it,
please report back (working or not) so the matrix above can be updated.

## 8. Manual acceptance checklist

Run these two scenarios before trusting a change to the plugin. Each is
setup once, then a verify smoke test.

**attach + Comet**

- [ ] Set `mode` to `attach`, `browser` to `comet`
- [ ] Run `/shopify-embedded-app-verify:setup-embedded-app-verify` — CDP comes up on Comet's
      default profile, no login prompt (session already authenticated)
- [ ] Ask the agent to verify any small, real change in a Shopify embedded
      app project — confirm a dedicated verify window opens, the app iframe
      is pierced, the loop reports pass/fail, and the window closes
      afterward without disturbing your other Comet tabs

**profile + Chrome**

- [ ] Set `mode` to `profile`, `browser` to `chrome`
- [ ] Run `/shopify-embedded-app-verify:setup-embedded-app-verify` — the automation profile
      launches, you log into the Shopify admin once, and
      `.claude/shopify-verify.json` is written
- [ ] Quit and relaunch Chrome (or reboot); ask the agent to verify a change
      again — confirm no re-login is needed and the smoke test still passes
