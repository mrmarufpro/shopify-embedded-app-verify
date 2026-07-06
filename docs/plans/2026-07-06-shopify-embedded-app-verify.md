# shopify-embedded-app-verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin (own GitHub marketplace repo) that lets an agent verify Shopify embedded-app changes by driving the real, authenticated Shopify admin in the developer's browser.

**Architecture:** A bundled Playwright MCP server attaches to a local Chromium over CDP (`--cdp-endpoint`). A zero-dependency Node preflight script (`ensure-browser.mjs`) guarantees a CDP-enabled browser is running in one of two modes: `attach` (developer's daily browser + live session, e.g. Comet) or `profile` (dedicated automation profile with a one-time Shopify login — required for Chrome/Edge 136+, which block CDP on the default profile). Two skills orchestrate everything: `setup` (first-run wizard) and `verify` (the loop: dedicated verify window → navigate embedded app → pierce iframe → interact → assert → report).

**Tech Stack:** Node ≥18 ESM (no npm deps), `node --test`, Claude Code plugin system (plugin.json / userConfig / `.mcp.json` / skills), `@playwright/mcp` via npx, GitHub Actions.

**Spec:** `docs/specs/2026-07-06-shopify-embedded-app-verify-design.md` (approved). The spec is the source of truth for behavior; this plan is the build order.

## Global Constraints

- Repo root for every command: `~/works/open_source_projects/shopify-embedded-app-verify` (git repo exists, `main` branch).
- `scripts/ensure-browser.mjs` must have **zero npm dependencies** — Node built-ins only, Node ≥18 (global `fetch`).
- One script serves macOS (`darwin`), Windows (`win32`), Linux (`linux`).
- Machine-readable failure codes, exact strings: `BROWSER_NOT_FOUND` (exit 2), `CDP_BLOCKED_DEFAULT_PROFILE` (exit 3), `PORT_TIMEOUT` (exit 4).
- Skills must never auto-start the project's dev server, never touch tabs other than the verify window/tab, and must delete run screenshots by default (keep on explicit request → `<project>/.claude/verify-screenshots/<timestamp>/`).
- Test fixtures use descriptive names and named constants (no single-letter identifiers, no cryptic fixture ids).
- All JSON committed must parse (`node -e "JSON.parse(...)"` check before commit).
- Plugin name everywhere: `shopify-embedded-app-verify`.

## File Structure

```
shopify-embedded-app-verify/
├── .claude-plugin/
│   ├── plugin.json            # Task 7 — manifest + userConfig
│   └── marketplace.json       # Task 10 — marketplace manifest
├── .github/workflows/ci.yml   # Task 11
├── .mcp.json                  # Task 7 — bundled Playwright MCP (CDP attach)
├── package.json               # Task 1
├── .gitignore                 # Task 1
├── LICENSE                    # Task 1 (MIT)
├── scripts/
│   └── ensure-browser.mjs     # Tasks 2–6 — the only executable code
├── skills/
│   ├── setup/SKILL.md         # Task 9
│   └── verify/SKILL.md        # Task 8
├── tests/
│   └── ensure-browser.test.mjs # Tasks 2–5
└── README.md                  # Task 12
```

`ensure-browser.mjs` is deliberately a single file: pure, exported, unit-tested functions at the top (`candidatePaths`, `launchArgs`, `verifyProfileDir`, `quitCommand`, `processCheckCommand`, `probeCdp`, `waitFor`, `ERROR_CODES`) and a thin `main()` at the bottom that only wires them together with `child_process`/`fs` side effects.

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `LICENSE`

**Interfaces:**
- Produces: `npm test` runs `node --test tests/`; ESM everywhere (`"type": "module"`).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "shopify-embedded-app-verify",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Claude Code plugin: agentic verify loop for Shopify embedded apps via the developer's authenticated browser",
  "license": "MIT",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
*.png
.DS_Store
```

- [ ] **Step 3: Write `LICENSE`** — standard MIT text, copyright `2026 Maruf Ahmed`.

- [ ] **Step 4: Sanity check**

Run: `cd ~/works/open_source_projects/shopify-embedded-app-verify && node -e "JSON.parse(require('fs').readFileSync('package.json'))" && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore LICENSE
git commit -m "chore: scaffold plugin repo"
```

---

### Task 2: Browser binary candidates (`candidatePaths`)

**Files:**
- Create: `scripts/ensure-browser.mjs`
- Create: `tests/ensure-browser.test.mjs`

**Interfaces:**
- Produces: `candidatePaths(browser: string, platform: string, env: object) => string[]` — ordered candidate binary locations. Absolute or path-separator-containing input returns `[input]` unchanged. Unknown browser/platform → `[]`. Linux entries may be bare PATH names.

- [ ] **Step 1: Write the failing tests**

`tests/ensure-browser.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidatePaths } from "../scripts/ensure-browser.mjs";

const WINDOWS_ENV = {
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
};

test("candidatePaths: chrome on macOS", () => {
  assert.deepEqual(candidatePaths("chrome", "darwin", {}), [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
});

test("candidatePaths: comet on macOS", () => {
  assert.deepEqual(candidatePaths("comet", "darwin", {}), [
    "/Applications/Comet.app/Contents/MacOS/Comet",
  ]);
});

test("candidatePaths: chrome on Windows uses env program dirs", () => {
  const paths = candidatePaths("chrome", "win32", WINDOWS_ENV);
  assert.ok(paths.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(paths.includes("C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"));
});

test("candidatePaths: chrome on Linux returns PATH names", () => {
  assert.deepEqual(candidatePaths("chrome", "linux", {}), ["google-chrome", "google-chrome-stable"]);
});

test("candidatePaths: custom absolute path passes through on macOS/Linux", () => {
  assert.deepEqual(candidatePaths("/opt/thorium/thorium", "linux", {}), ["/opt/thorium/thorium"]);
});

test("candidatePaths: custom absolute path passes through on Windows", () => {
  assert.deepEqual(candidatePaths("D:\\Browsers\\comet.exe", "win32", WINDOWS_ENV), ["D:\\Browsers\\comet.exe"]);
});

test("candidatePaths: comet on Linux is not distributed", () => {
  assert.deepEqual(candidatePaths("comet", "linux", {}), []);
});

test("candidatePaths: unknown browser name", () => {
  assert.deepEqual(candidatePaths("netscape", "darwin", {}), []);
});

test("candidatePaths: browser name is case-insensitive", () => {
  assert.equal(candidatePaths("Chrome", "darwin", {}).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../scripts/ensure-browser.mjs'`

- [ ] **Step 3: Write minimal implementation**

`scripts/ensure-browser.mjs`:

```js
#!/usr/bin/env node
// Preflight for the shopify-embedded-app-verify plugin: ensure a Chromium
// with an open CDP port is running, per the developer's browser/mode config.
// Zero npm dependencies; Node >= 18.

export const ERROR_CODES = {
  BROWSER_NOT_FOUND: 2,
  CDP_BLOCKED_DEFAULT_PROFILE: 3,
  PORT_TIMEOUT: 4,
};

export function candidatePaths(browser, platform, env) {
  if (browser.includes("/") || browser.includes("\\")) return [browser];
  const key = browser.toLowerCase();
  const programFiles = env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA || "";
  const maps = {
    darwin: {
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      chromium: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      comet: ["/Applications/Comet.app/Contents/MacOS/Comet"],
      brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    },
    win32: {
      chrome: [
        `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
      chromium: [`${localAppData}\\Chromium\\Application\\chrome.exe`],
      comet: [`${localAppData}\\Perplexity\\Comet\\Application\\comet.exe`],
      brave: [`${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`],
      edge: [
        `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
    },
    linux: {
      chrome: ["google-chrome", "google-chrome-stable"],
      chromium: ["chromium", "chromium-browser"],
      comet: [],
      brave: ["brave-browser"],
      edge: ["microsoft-edge"],
    },
  };
  return maps[platform]?.[key] ?? [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/ensure-browser.mjs tests/ensure-browser.test.mjs
git commit -m "feat: per-OS browser binary candidate resolution"
```

---

### Task 3: Launch arguments and profile dir

**Files:**
- Modify: `scripts/ensure-browser.mjs` (append)
- Modify: `tests/ensure-browser.test.mjs` (append)

**Interfaces:**
- Produces: `verifyProfileDir(home: string) => string` (`<home>/.claude-browser-profiles/shopify-verify`, OS-native separators); `launchArgs(mode: "attach"|"profile", port: string, home: string) => string[]`.

- [ ] **Step 1: Write the failing tests** (append to `tests/ensure-browser.test.mjs`)

```js
import path from "node:path";
import { launchArgs, verifyProfileDir } from "../scripts/ensure-browser.mjs";

const FAKE_HOME = path.join(path.sep, "home", "dev");

test("verifyProfileDir: under home", () => {
  assert.equal(
    verifyProfileDir(FAKE_HOME),
    path.join(FAKE_HOME, ".claude-browser-profiles", "shopify-verify")
  );
});

test("launchArgs: attach mode only sets the debug port", () => {
  assert.deepEqual(launchArgs("attach", "9222", FAKE_HOME), ["--remote-debugging-port=9222"]);
});

test("launchArgs: profile mode adds the dedicated user-data-dir", () => {
  assert.deepEqual(launchArgs("profile", "9223", FAKE_HOME), [
    `--user-data-dir=${verifyProfileDir(FAKE_HOME)}`,
    "--remote-debugging-port=9223",
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `launchArgs` is not exported

- [ ] **Step 3: Implement** (append to `scripts/ensure-browser.mjs`)

```js
import path from "node:path";

export function verifyProfileDir(home) {
  return path.join(home, ".claude-browser-profiles", "shopify-verify");
}

export function launchArgs(mode, port, home) {
  const args = [`--remote-debugging-port=${port}`];
  if (mode === "profile") args.unshift(`--user-data-dir=${verifyProfileDir(home)}`);
  return args;
}
```

(Move the `import path` line to the top of the file with the other imports.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/ensure-browser.mjs tests/ensure-browser.test.mjs
git commit -m "feat: launch args and dedicated profile dir"
```

---

### Task 4: Per-OS graceful quit and process check commands

**Files:**
- Modify: `scripts/ensure-browser.mjs` (append)
- Modify: `tests/ensure-browser.test.mjs` (append)

**Interfaces:**
- Produces: `quitCommand(binaryPath: string, platform: string) => {cmd: string, args: string[]}` — graceful quit (session-restore preserving: macOS `osascript quit app`, Windows `taskkill` **without** `/F`, Linux `pkill -TERM`); `processCheckCommand(binaryPath: string, platform: string) => {cmd: string, args: string[]}` — command whose exit 0 means the browser is running.

- [ ] **Step 1: Write the failing tests** (append)

```js
import { processCheckCommand, quitCommand } from "../scripts/ensure-browser.mjs";

const COMET_MAC_BINARY = "/Applications/Comet.app/Contents/MacOS/Comet";
const CHROME_WIN_BINARY = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CHROME_LINUX_BINARY = "google-chrome";

test("quitCommand: macOS quits the .app by name via osascript", () => {
  assert.deepEqual(quitCommand(COMET_MAC_BINARY, "darwin"), {
    cmd: "osascript",
    args: ["-e", 'quit app "Comet"'],
  });
});

test("quitCommand: Windows uses taskkill without /F (graceful WM_CLOSE)", () => {
  const command = quitCommand(CHROME_WIN_BINARY, "win32");
  assert.deepEqual(command, { cmd: "taskkill", args: ["/IM", "chrome.exe"] });
  assert.ok(!command.args.includes("/F"));
});

test("quitCommand: Linux sends SIGTERM via pkill", () => {
  assert.deepEqual(quitCommand(CHROME_LINUX_BINARY, "linux"), {
    cmd: "pkill",
    args: ["-TERM", "-f", "google-chrome"],
  });
});

test("processCheckCommand: macOS/Linux use pgrep", () => {
  assert.deepEqual(processCheckCommand(COMET_MAC_BINARY, "darwin"), {
    cmd: "pgrep",
    args: ["-f", "Comet"],
  });
});

test("processCheckCommand: Windows uses tasklist filter", () => {
  assert.deepEqual(processCheckCommand(CHROME_WIN_BINARY, "win32"), {
    cmd: "tasklist",
    args: ["/FI", "IMAGENAME eq chrome.exe", "/NH"],
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `quitCommand` is not exported

- [ ] **Step 3: Implement** (append)

```js
function processName(binaryPath, platform) {
  const base = binaryPath.split(platform === "win32" ? "\\" : "/").pop();
  return base;
}

export function quitCommand(binaryPath, platform) {
  if (platform === "darwin") {
    const appMatch = binaryPath.match(/\/([^/]+)\.app\//);
    const appName = appMatch ? appMatch[1] : processName(binaryPath, platform);
    return { cmd: "osascript", args: ["-e", `quit app "${appName}"`] };
  }
  if (platform === "win32") {
    return { cmd: "taskkill", args: ["/IM", processName(binaryPath, platform)] };
  }
  return { cmd: "pkill", args: ["-TERM", "-f", processName(binaryPath, platform)] };
}

export function processCheckCommand(binaryPath, platform) {
  if (platform === "win32") {
    const imageName = processName(binaryPath, platform);
    return { cmd: "tasklist", args: ["/FI", `IMAGENAME eq ${imageName}`, "/NH"] };
  }
  return { cmd: "pgrep", args: ["-f", processName(binaryPath, platform)] };
}
```

Note: Windows `tasklist` exits 0 even with no match; `main()` (Task 6) treats win32 specially — a process counts as running only if the tasklist stdout mentions the image name.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/ensure-browser.mjs tests/ensure-browser.test.mjs
git commit -m "feat: per-OS graceful quit and process check commands"
```

---

### Task 5: CDP probe and poll helper

**Files:**
- Modify: `scripts/ensure-browser.mjs` (append)
- Modify: `tests/ensure-browser.test.mjs` (append)

**Interfaces:**
- Produces: `probeCdp(port: string|number, timeoutMs?: number) => Promise<boolean>` (GET `http://127.0.0.1:<port>/json/version`, ok → true, anything else → false); `waitFor(check: () => Promise<boolean>|boolean, timeoutMs: number, intervalMs?: number) => Promise<boolean>`.

- [ ] **Step 1: Write the failing tests** (append)

```js
import http from "node:http";
import { probeCdp, waitFor } from "../scripts/ensure-browser.mjs";

test("probeCdp: true when a server answers /json/version", async () => {
  const fakeCdpServer = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ Browser: "FakeChrome/1.0" }));
  });
  await new Promise((resolve) => fakeCdpServer.listen(0, "127.0.0.1", resolve));
  const port = fakeCdpServer.address().port;
  assert.equal(await probeCdp(port), true);
  fakeCdpServer.close();
});

test("probeCdp: false when nothing listens", async () => {
  assert.equal(await probeCdp(59999, 500), false);
});

test("waitFor: resolves true once the check passes", async () => {
  let callCount = 0;
  const passesOnThirdCall = () => ++callCount >= 3;
  assert.equal(await waitFor(passesOnThirdCall, 2000, 10), true);
});

test("waitFor: resolves false on timeout", async () => {
  const neverPasses = () => false;
  assert.equal(await waitFor(neverPasses, 100, 10), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `probeCdp` is not exported

- [ ] **Step 3: Implement** (append)

```js
export async function probeCdp(port, timeoutMs = 2000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitFor(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (21 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/ensure-browser.mjs tests/ensure-browser.test.mjs
git commit -m "feat: CDP probe and poll helper"
```

---

### Task 6: `main()` orchestration

**Files:**
- Modify: `scripts/ensure-browser.mjs` (append)

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: CLI behavior — env in (`CLAUDE_PLUGIN_OPTION_BROWSER`, `CLAUDE_PLUGIN_OPTION_MODE`, `CLAUDE_PLUGIN_OPTION_CDP_PORT`), exit 0 + `CDP alive on <port>` on success, or `<CODE>: <human message>` on stderr with the mapped exit code.

- [ ] **Step 1: Implement** (append; this is thin orchestration of already-tested parts — no new unit tests, smoke-tested in Step 2)

```js
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

function fail(code, message) {
  console.error(`${code}: ${message}`);
  process.exit(ERROR_CODES[code]);
}

function resolveBinary(browser, platform, env) {
  for (const candidate of candidatePaths(browser, platform, env)) {
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
    } else {
      const which = spawnSync(platform === "win32" ? "where" : "which", [candidate]);
      if (which.status === 0) return candidate;
    }
  }
  return null;
}

function isBrowserRunning(binaryPath, platform) {
  const { cmd, args } = processCheckCommand(binaryPath, platform);
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (platform === "win32") {
    return result.status === 0 && (result.stdout || "").toLowerCase().includes(args[1].split("eq ")[1].toLowerCase());
  }
  return result.status === 0;
}

async function main() {
  const browser = process.env.CLAUDE_PLUGIN_OPTION_BROWSER || "chrome";
  const mode = process.env.CLAUDE_PLUGIN_OPTION_MODE || "profile";
  const port = process.env.CLAUDE_PLUGIN_OPTION_CDP_PORT || "9222";
  const platform = process.platform;

  if (await probeCdp(port)) {
    console.log(`CDP alive on ${port}`);
    return;
  }

  const binaryPath = resolveBinary(browser, platform, process.env);
  if (!binaryPath) {
    fail(
      "BROWSER_NOT_FOUND",
      `No "${browser}" binary found for ${platform}. Install it or set the plugin's browser option to an absolute binary path.`
    );
  }

  if (mode === "attach" && isBrowserRunning(binaryPath, platform)) {
    console.log("Browser running without CDP — quitting gracefully (tabs restore on relaunch)...");
    const quit = quitCommand(binaryPath, platform);
    spawnSync(quit.cmd, quit.args);
    const quitDone = await waitFor(() => !isBrowserRunning(binaryPath, platform), 15000, 500);
    if (!quitDone) fail("PORT_TIMEOUT", "Browser did not quit within 15s. Close it manually and retry.");
  }

  if (mode === "profile") mkdirSync(verifyProfileDir(homedir()), { recursive: true });

  const child = spawn(binaryPath, launchArgs(mode, port, homedir()), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const portAlive = await waitFor(() => probeCdp(port), 20000, 500);
  if (!portAlive) {
    if (mode === "attach") {
      fail(
        "CDP_BLOCKED_DEFAULT_PROFILE",
        `"${browser}" ignored --remote-debugging-port on its default profile (Chrome/Edge 136+ block this). Switch the plugin's mode option to "profile".`
      );
    }
    fail("PORT_TIMEOUT", `CDP port ${port} did not open within 20s of launching ${binaryPath}.`);
  }
  console.log(`CDP alive on ${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
```

(Move the `import` lines to the top of the file with the other imports.)

- [ ] **Step 2: Smoke tests**

Run: `npm test`
Expected: PASS — importing the module must NOT trigger `main()` (the `import.meta.url` guard).

Run: `CLAUDE_PLUGIN_OPTION_BROWSER=doesnotexist node scripts/ensure-browser.mjs; echo "exit=$?"`
Expected: stderr starts `BROWSER_NOT_FOUND:`, prints `exit=2`

Run (macOS, Comet installed, attach mode):
`CLAUDE_PLUGIN_OPTION_BROWSER=comet CLAUDE_PLUGIN_OPTION_MODE=attach node scripts/ensure-browser.mjs; echo "exit=$?"`
Expected: `CDP alive on 9222`, `exit=0` (relaunches Comet with the flag if needed)

- [ ] **Step 3: Commit**

```bash
git add scripts/ensure-browser.mjs
git commit -m "feat: preflight main flow — probe, quit, relaunch, poll"
```

---

### Task 7: Plugin manifest and bundled MCP server

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`

**Interfaces:**
- Produces: userConfig keys `browser`, `mode`, `cdp_port` — reachable in skills/scripts as `CLAUDE_PLUGIN_OPTION_BROWSER` / `_MODE` / `_CDP_PORT` env vars and `${user_config.*}` substitutions. MCP server name `shopify-verify-browser` (tools appear as `mcp__shopify-verify-browser__browser_*`).

- [ ] **Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "shopify-embedded-app-verify",
  "displayName": "Shopify Embedded App Verify",
  "description": "Agentic verify loop for Shopify embedded apps — drives the real, authenticated Shopify admin in the developer's own browser via CDP.",
  "version": "0.1.0",
  "author": { "name": "Maruf Ahmed" },
  "repository": "https://github.com/mrmarufpro/shopify-embedded-app-verify",
  "license": "MIT",
  "keywords": ["shopify", "embedded-app", "verification", "playwright", "browser", "agentic"],
  "userConfig": {
    "browser": {
      "type": "string",
      "title": "Browser",
      "description": "comet | chrome | chromium | brave | edge — or an absolute path to any Chromium-based browser binary",
      "default": "chrome"
    },
    "mode": {
      "type": "string",
      "title": "Session mode",
      "description": "attach = your daily browser + its logged-in session (browser must allow CDP on the default profile, e.g. Comet). profile = dedicated automation profile, one-time Shopify login (works with every Chromium; required for Chrome/Edge).",
      "default": "profile"
    },
    "cdp_port": {
      "type": "string",
      "title": "CDP port",
      "description": "Local Chrome DevTools Protocol port the browser listens on",
      "default": "9222"
    }
  }
}
```

- [ ] **Step 2: Write `.mcp.json`**

```json
{
  "mcpServers": {
    "shopify-verify-browser": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "http://localhost:${user_config.cdp_port}"]
    }
  }
}
```

- [ ] **Step 3: Validate**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json')); JSON.parse(require('fs').readFileSync('.mcp.json')); console.log('OK')"`
Expected: `OK`

Run: `claude plugin validate . 2>&1 || true`
Expected: passes; if the CLI reports unknown/misplaced fields, fix per its message (the docs' schema wins over this plan).

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .mcp.json
git commit -m "feat: plugin manifest with per-dev userConfig and bundled Playwright MCP"
```

---

### Task 8: `verify` skill

**Files:**
- Create: `skills/verify/SKILL.md`

**Interfaces:**
- Consumes: `ensure-browser.mjs` CLI contract (Task 6), MCP tools `mcp__shopify-verify-browser__browser_*` (Task 7), project config `.claude/shopify-verify.json` (written by Task 9's skill).

- [ ] **Step 1: Write `skills/verify/SKILL.md`** — full content:

````markdown
---
name: verify
description: Verify a Shopify embedded-app change by driving the real, authenticated Shopify admin in the developer's browser. Use after changing app code when the user asks to verify, check, or test the change in the browser/admin, or asks to run the verify loop.
---

# Verify an embedded Shopify app change in the real admin

Closed loop: preflight → dedicated verify window → navigate the embedded app →
interact → assert against the plan → report. On mismatch: fix the code and loop.

Hard rules:
- NEVER start the project's dev server. If it is down, tell the user and stop.
- NEVER touch browser tabs other than the verify tab you created. The rest of
  the browser belongs to the developer.
- Delete every screenshot you take once the report is delivered (see step 6).

## 1. Load project config

Read `.claude/shopify-verify.json` in the project root:

```json
{ "appHandle": "...", "storeDomain": "...", "iframeSelector": "iframe[name=\"app-iframe\"]" }
```

If the file is missing, run the `setup` skill flow first (same plugin), then continue.

## 2. Preflight

1. Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-browser.mjs`
   - Exit 0 → CDP is live.
   - Non-zero → show the script's stderr message to the user verbatim and stop.
     (`CDP_BLOCKED_DEFAULT_PROFILE` means: tell the user to switch the plugin's
     mode option to "profile" via /plugin → configure.)
2. Probe the dev server: read `application_url` from the project's
   `shopify.app.toml`; `curl -s -o /dev/null -w "%{http_code}" --max-time 5 <url>`.
   Any HTTP status (including 4xx) = tunnel alive. Connection failure/timeout =
   ask the user to start their dev server, then stop. Do not start it yourself.

## 3. Open the verify window

Create a separate browser window so the developer's windows stay untouched.
Use `browser_run_code_unsafe` (adapt the wrapper to the tool's documented shape):

```js
async ({ context }) => {
  const anyPage = context.pages()[0];
  const session = await context.newCDPSession(anyPage);
  const { targetId } = await session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  await session.detach();
  return targetId;
}
```

Then `browser_tabs` (action: list), select the newly created `about:blank` tab.
Every subsequent navigation/interaction happens in this tab only.

## 4. Drive the app

1. Navigate to `https://admin.shopify.com/store/<storeDomain>/apps/<appHandle>/<page-path>`
   (`<page-path>` = the app route relevant to the change being verified).
2. If the URL redirects to `accounts.shopify.com`: the Shopify session expired.
   - attach mode → ask the user to log into the Shopify admin in their browser, wait, retry.
   - profile mode → leave the verify window open on the login page, ask the user
     to log in there once, wait for their confirmation, retry.
3. Wait for the app iframe (`iframeSelector` from config). The embedded app lives
   entirely inside that iframe — target all app selectors through it.
4. Interact per the plan: `browser_snapshot` first, then click/type/select,
   `browser_wait_for` after actions that trigger loading.
5. Evidence: accessibility snapshots plus screenshots. Save screenshots to a
   temp location (never the project tree) and remember every path.

## 5. Assert and loop

Compare what the page shows against the expected behavior (the plan, or the
change just made). Judge like a reviewer: exact copy, state transitions,
toasts, network side effects visible in the UI.

- PASS → report what was verified with evidence, go to step 6.
- FAIL → report the exact mismatch (expected vs observed), fix the code, then
  re-verify: the dev server hot-reloads, so a reload of the admin page
  (step 4.1) picks up the change.
- Loop guard: 3 consecutive failures on the same assertion → stop, report all
  evidence, hand control back to the user.

## 6. Cleanup

1. Close the verify tab/window — unless the user asked to keep it open.
2. Delete every screenshot taken during this run. Exception: if the user asked
   to keep them, move them to `<project>/.claude/verify-screenshots/<YYYYMMDD-HHmmss>/`
   and say where they are.

## Failure handling

| Symptom | Action |
|---------|--------|
| `ensure-browser.mjs` non-zero | Show its message verbatim; stop |
| Redirect to `accounts.shopify.com` | Session expired → step 4.2 |
| Tunnel probe connection failure | Ask user to start their dev server; stop |
| Iframe never appears | Screenshot the admin page; report what actually rendered (404 / install prompt / error banner); if 404, the app may not be installed on this store |
| 3 consecutive assertion failures | Stop and report; do not thrash |
````

- [ ] **Step 2: Review against spec §4.7/§5** — every loop step, hard rule, and failure row present.

- [ ] **Step 3: Commit**

```bash
git add skills/verify/SKILL.md
git commit -m "feat: verify skill — the agentic admin verification loop"
```

---

### Task 9: `setup` skill

**Files:**
- Create: `skills/setup/SKILL.md`

**Interfaces:**
- Produces: `.claude/shopify-verify.json` in the consuming project (shape consumed by Task 8).

- [ ] **Step 1: Write `skills/setup/SKILL.md`** — full content:

````markdown
---
name: setup
description: One-time setup for the Shopify embedded-app verify loop in a project. Use when the user asks to set up / configure the verify loop, or when the verify skill finds no project config.
---

# Set up the embedded-app verify loop

Goal: a CDP-enabled, Shopify-authenticated browser plus a project config file.

## 1. Show the resolved developer config

Read env: `CLAUDE_PLUGIN_OPTION_BROWSER`, `CLAUDE_PLUGIN_OPTION_MODE`,
`CLAUDE_PLUGIN_OPTION_CDP_PORT`. Tell the user what is configured and that it
can be changed anytime via `/plugin` → shopify-embedded-app-verify → configure.

## 2. Ensure the browser

Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-browser.mjs`

- Exit 0 → continue.
- `CDP_BLOCKED_DEFAULT_PROFILE` → explain: this browser refuses CDP on its
  default profile (Chrome/Edge 136+). The user must switch the plugin's mode
  option to "profile" (dedicated automation profile, one-time login). Stop.
- Other non-zero → show the message verbatim; stop.

## 3. Verify Shopify authentication

Navigate (in a new tab via the plugin's browser tools) to
`https://admin.shopify.com`.

- Lands on a store dashboard (`admin.shopify.com/store/...`) → authenticated.
- Redirects to `accounts.shopify.com` login:
  - profile mode, first run → expected. Tell the user: "Log into the Shopify
    admin in the browser window that just opened — one time only; the session
    persists." Wait for their confirmation, then re-check.
  - attach mode → ask the user to log into Shopify in their browser, then re-check.

Close the tab you opened once authenticated.

## 4. Write the project config

1. `appHandle`: read `handle` from the project's `shopify.app.toml`. Multiple
   toml files (e.g. `shopify.app.<env>.toml`) → ask which one is the dev app.
2. `storeDomain`: ask the user for the dev store subdomain
   (`<storeDomain>.myshopify.com` → store part only, e.g. `store-seo-app-test`).
3. Write `.claude/shopify-verify.json`:

```json
{
  "appHandle": "<from toml>",
  "storeDomain": "<from user>",
  "iframeSelector": "iframe[name=\"app-iframe\"]"
}
```

## 5. Smoke test

1. Open a verify window (same CDP snippet as the verify skill, step 3).
2. Navigate to `https://admin.shopify.com/store/<storeDomain>/apps/<appHandle>`.
3. Wait for the app iframe; take a screenshot; confirm the app rendered.
   - 404 → the app is not installed on this store; point the user to the dev
     server output's install link.
   - Iframe loads an error/tunnel page → dev server is down; the loop needs it
     running, but setup itself is complete.
4. Report the result, close the verify window, delete the screenshot.
````

- [ ] **Step 2: Review against spec §4.8** — all five setup steps covered.

- [ ] **Step 3: Commit**

```bash
git add skills/setup/SKILL.md
git commit -m "feat: setup skill — first-run wizard"
```

---

### Task 10: Marketplace manifest + local install verification

**Files:**
- Create: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "shopify-embedded-app-verify",
  "owner": { "name": "Maruf Ahmed" },
  "plugins": [
    {
      "name": "shopify-embedded-app-verify",
      "source": "./",
      "description": "Agentic verify loop for Shopify embedded apps — drives the real, authenticated Shopify admin in the developer's own browser."
    }
  ]
}
```

If `claude plugin marketplace add` (Step 2) rejects the manifest location or shape, follow the CLI error — current docs win over this plan (older layouts used repo-root `marketplace.json`).

- [ ] **Step 2: Verify the full local install flow**

```bash
claude plugin marketplace add ~/works/open_source_projects/shopify-embedded-app-verify
claude plugin install shopify-embedded-app-verify@shopify-embedded-app-verify
claude plugin list
```

Expected: plugin installs; `claude plugin list` shows `shopify-embedded-app-verify`. In a fresh `claude` session: `/shopify-embedded-app-verify:setup` and `:verify` appear in the skill list, and MCP tools `mcp__shopify-verify-browser__*` are present (ToolSearch or /mcp).

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/marketplace.json
git commit -m "feat: marketplace manifest for direct GitHub install"
```

---

### Task 11: CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
```

- [ ] **Step 2: Verify locally**

Run: `npm test`
Expected: PASS (21 tests) — the same command CI runs.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: unit tests on ubuntu/macos/windows"
```

---

### Task 12: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** covering, in this order (write real prose, not stubs — source facts from the spec):

1. **What it is** — one paragraph: agentic verify loop for Shopify embedded apps; agent drives the real authenticated admin in your browser; born from the constraint that the Claude Chrome extension is subscription-only and vanilla Playwright MCP is unauthenticated.
2. **Install** — the two commands from Task 10 (GitHub form: `claude plugin marketplace add mrmarufpro/shopify-embedded-app-verify`).
3. **Configure** — the three userConfig options table (browser / mode / cdp_port) and the attach-vs-profile decision: attach = Comet-class browsers only (Chrome/Edge 136+ block CDP on the default profile — link the Chromium security note), profile = any Chromium, one-time login, weeks-persistent session.
4. **Per-project setup** — run `/shopify-embedded-app-verify:setup`; what `.claude/shopify-verify.json` contains; dev server must be running (`shopify app dev`) and is never auto-started.
5. **Usage** — ask the agent to verify a change; what the loop does; screenshots deleted by default, "keep the screenshots" to retain.
6. **Security** — verbatim from spec §6: an open CDP port lets any local process control the browser and its sessions; localhost-only; quit/relaunch normally to close it; profile mode confines exposure to the automation profile.
7. **Platform support matrix** — macOS (proven live), Windows/Linux (unit-tested paths, community verification welcome).
8. **Manual acceptance checklist** — attach+Comet and profile+Chrome: setup → verify smoke, per spec §7.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README — install, config, modes, security"
```

---

### Task 13: Dogfood acceptance (manual, with the user)

**Files:** none (acceptance run in the StoreSEO repo)

- [ ] **Step 1: Install the plugin locally** (Task 10 flow) and start a fresh Claude session in `~/works/storeware_apps/storeseo` with `pnpm dev` running (user's terminal).

- [ ] **Step 2: Run `/shopify-embedded-app-verify:setup`**
Expected: attach+Comet path — CDP ensured, auth verified without login, `.claude/shopify-verify.json` written (`appHandle: storeseo-dev`, `storeDomain: store-seo-app-test`), smoke test renders the app in a separate window, screenshot deleted.

- [ ] **Step 3: Full loop test** — make a trivial visible frontend change in StoreSEO (e.g. change a dashboard heading), ask the agent to verify it.
Expected: agent opens verify window, navigates, pierces iframe, confirms the changed text, reports PASS, closes window, deletes screenshots.

- [ ] **Step 4: Fix findings** — anything broken becomes a fix commit in the plugin repo; repeat until the loop passes end-to-end.

- [ ] **Step 5: Publish** — create GitHub repo `mrmarufpro/shopify-embedded-app-verify`, push `main`, re-test install from the GitHub form.

```bash
gh repo create mrmarufpro/shopify-embedded-app-verify --public --source . --push
claude plugin marketplace add mrmarufpro/shopify-embedded-app-verify
```
