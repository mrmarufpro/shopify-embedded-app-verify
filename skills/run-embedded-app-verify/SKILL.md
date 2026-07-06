---
name: run-embedded-app-verify
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

If the file is missing, run the `setup-embedded-app-verify` skill flow first (same plugin), then continue.

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
Use `browser_run_code_unsafe` (the code is invoked with the current page as
its single argument; if the tool reports no open tab, run `browser_tabs`
action list first so one is selected):

```js
async (page) => {
  const session = await page.context().newCDPSession(page);
  const { targetId } = await session.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  await session.detach();
  return targetId;
}
```

**Save the returned targetId — step 6 closes the window with it.**

Then `browser_tabs` (action: list) and select the new `about:blank` entry.
Match it by URL, never by position: the developer may have dozens of tabs
and list order is not stable. Every subsequent navigation/interaction
happens in this tab only.

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

1. Close the verify window — unless the user asked to keep it open — with
   `browser_run_code_unsafe` and the targetId saved in step 3:

```js
async (page) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Target.closeTarget", { targetId: "<targetId from step 3>" });
}
```

   Never use `browser_close` or close-by-index instead: both act on the
   MCP's notion of the current tab, which closes the wrong tab — or
   nothing — when the developer has many tabs open. If the tool errors
   because its own page just closed, the window did close: that is success.
2. Delete every screenshot taken during this run. Exception: if the user asked
   to keep them, move them to `<project>/.claude/verify-screenshots/<YYYYMMDD-HHmmss>/`
   and say where they are.

## Failure handling

| Symptom | Action |
|---------|--------|
| `ensure-browser.mjs` non-zero | Show its message verbatim; stop |
| Redirect to `accounts.shopify.com` | Session expired → step 4.2 |
| Tunnel probe connection failure | Ask user to start their dev server; stop |
| Iframe never appears | Screenshot the admin page; report what actually rendered (404 / install prompt / error banner); if 404, the app may not be installed on this store — point the user to the install link in their dev server output |
| 3 consecutive assertion failures | Stop and report; do not thrash |
