#!/usr/bin/env node
// Preflight for the shopify-embedded-app-verify plugin: ensure a Chromium
// with an open CDP port is running, per the developer's browser/mode config.
// Zero npm dependencies; Node >= 18.

import path from "node:path";

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

export function verifyProfileDir(home) {
  return path.join(home, ".claude-browser-profiles", "shopify-verify");
}

export function launchArgs(mode, port, home) {
  const args = [`--remote-debugging-port=${port}`];
  if (mode === "profile") args.unshift(`--user-data-dir=${verifyProfileDir(home)}`);
  return args;
}

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
