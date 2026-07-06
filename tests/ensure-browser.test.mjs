import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { candidatePaths, launchArgs, verifyProfileDir, processCheckCommand, quitCommand, probeCdp, waitFor } from "../scripts/ensure-browser.mjs";

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

const COMET_WIN_FORWARD_SLASH_BINARY = "C:/Browsers/comet.exe";

test("quitCommand: Windows binary path with forward slashes still resolves basename", () => {
  assert.deepEqual(quitCommand(COMET_WIN_FORWARD_SLASH_BINARY, "win32"), {
    cmd: "taskkill",
    args: ["/IM", "comet.exe"],
  });
});

test("processCheckCommand: Windows binary path with forward slashes still resolves basename", () => {
  assert.deepEqual(processCheckCommand(COMET_WIN_FORWARD_SLASH_BINARY, "win32"), {
    cmd: "tasklist",
    args: ["/FI", "IMAGENAME eq comet.exe", "/NH"],
  });
});

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
