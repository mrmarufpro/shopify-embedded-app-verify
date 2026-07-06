#!/usr/bin/env node
// Preflight for the shopify-embedded-app-verify plugin: ensure a Chromium
// with an open CDP port is running, per the developer's browser/mode config.
// Zero npm dependencies; Node >= 18.

import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const ERROR_CODES = {
  BROWSER_NOT_FOUND: 2,
  CDP_BLOCKED_DEFAULT_PROFILE: 3,
  PORT_TIMEOUT: 4,
};

// Config precedence: CLI args (from skill ${user_config.*} substitution) >
// CLAUDE_PLUGIN_OPTION_* env (only set for plugin subprocesses like hooks —
// NOT for skill-issued Bash commands) > defaults. An unsubstituted
// "${user_config.*}" literal (older CLI) counts as unset.
export function resolveConfig(argv, env) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--(browser|mode|port)$/);
    if (match) {
      args[match[1]] = argv[i + 1] ?? "";
      i++;
    }
  }
  const pick = (argValue, envKey, fallback) => {
    let value = (argValue ?? env[envKey] ?? "").trim();
    if (value.startsWith("${")) value = "";
    return value || fallback;
  };
  return {
    browser: pick(args.browser, "CLAUDE_PLUGIN_OPTION_BROWSER", "chrome"),
    mode: pick(args.mode, "CLAUDE_PLUGIN_OPTION_MODE", "profile").toLowerCase(),
    port: pick(args.port, "CLAUDE_PLUGIN_OPTION_CDP_PORT", "9222"),
  };
}

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

export function verifyProfileDir(home) {
  return path.join(home, ".claude-browser-profiles", "shopify-verify");
}

export function launchArgs(mode, port, home) {
  const args = [`--remote-debugging-port=${port}`];
  if (mode === "profile") args.unshift(`--user-data-dir=${verifyProfileDir(home)}`);
  return args;
}

function processName(binaryPath, platform) {
  return platform === "win32" ? path.win32.basename(binaryPath) : path.posix.basename(binaryPath);
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
  const { browser, mode, port } = resolveConfig(process.argv.slice(2), process.env);
  if (mode !== "attach" && mode !== "profile") {
    console.error(`UNEXPECTED: invalid mode "${mode}" — use "attach" or "profile"`);
    process.exit(1);
  }
  const platform = process.platform;
  console.log(`Config: browser=${browser} mode=${mode} port=${port}`);

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
  child.on("error", (error) => {
    fail("BROWSER_NOT_FOUND", `Failed to launch ${binaryPath}: ${error.message}`);
  });
  child.unref();

  const portAlive = await waitFor(() => probeCdp(port), 20000, 500);
  if (!portAlive) {
    if (mode === "attach") {
      fail(
        "CDP_BLOCKED_DEFAULT_PROFILE",
        `CDP port ${port} did not open after relaunching "${browser}". Most likely cause: the browser blocks --remote-debugging-port on its default profile (Chrome/Edge 136+). Switch the plugin's mode option to "profile".`
      );
    }
    fail("PORT_TIMEOUT", `CDP port ${port} did not open within 20s of launching ${binaryPath}.`);
  }
  console.log(`CDP alive on ${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`UNEXPECTED: ${error?.message ?? error}`);
    process.exit(1);
  });
}
