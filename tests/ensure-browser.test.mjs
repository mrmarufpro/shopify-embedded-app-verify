import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { candidatePaths, launchArgs, verifyProfileDir } from "../scripts/ensure-browser.mjs";

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
