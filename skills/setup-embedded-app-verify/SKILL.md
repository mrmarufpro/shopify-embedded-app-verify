---
name: setup-embedded-app-verify
description: One-time setup for the Shopify embedded-app verify loop in a project. Use when the user asks to set up / configure the verify loop, or when the run-embedded-app-verify skill finds no project config.
---

# Set up the embedded-app verify loop

Goal: a CDP-enabled, Shopify-authenticated browser plus a project config file.

## 1. Show the resolved developer config

The plugin config is substituted into this skill at load time:

- browser: `${user_config.browser}`
- mode: `${user_config.mode}`
- cdp_port: `${user_config.cdp_port}`

A blank value (or a literal dollar-brace placeholder) means the default
applies: chrome / profile / 9222. Tell the user the resolved values and that
they can be changed anytime via `/plugin` → shopify-embedded-app-verify →
configure (changes reach skills after `/reload-plugins` or a session restart).
Do NOT read `CLAUDE_PLUGIN_OPTION_*` env vars — they are only set for plugin
subprocesses such as hooks, never for Bash commands you run.

## 2. Ensure the browser

Run:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-browser.mjs --browser "${user_config.browser}" --mode "${user_config.mode}" --port "${user_config.cdp_port}" --url "https://admin.shopify.com"
```

Note the `BROWSER_STATE:` line in the output — `launched` or `reused` —
step 3 branches on it.

- Exit 0 → continue.
- `CDP_BLOCKED_DEFAULT_PROFILE` → explain: this browser refuses CDP on its
  default profile (Chrome/Edge 136+). The user must switch the plugin's mode
  option to "profile" (dedicated automation profile, one-time login). Stop.
- `BROWSER_MISMATCH` → the CDP port is already served by a browser that is
  not the configured one (and not one this plugin launched). Show the
  message verbatim — the user must quit that browser or change the plugin's
  browser/cdp_port option. Stop. (A stale automation browser from an earlier
  run is handled automatically — the script quits it and relaunches.)
- Other non-zero → show the message verbatim; stop.

## 3. Open the verify window and check Shopify authentication

Never open tabs in the developer's own windows.

**Preflight said `BROWSER_STATE: launched`** (profile mode): the browser
opened directly at `https://admin.shopify.com` — its only tab IS the
verify window. `browser_tabs` (action: list), select that tab, grab its
targetId with `browser_run_code_unsafe`, and continue to the auth check
below:

```js
async (page) => {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  return targetInfo.targetId;
}
```

**Preflight said `BROWSER_STATE: reused`**: `browser_tabs` (action: list),
then:

**Case A — the list shows only blank tabs** (`about:blank` /
`chrome://new-tab-page` — a browser nobody is using): reuse that startup
window instead of opening a second one. Select it, grab its targetId with
`browser_run_code_unsafe`:

```js
async (page) => {
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  return targetInfo.targetId;
}
```

then `browser_navigate` it to `https://admin.shopify.com`.

**Case B — any non-blank tabs exist** (attach mode / browser already in
use): open a dedicated verify window with `browser_run_code_unsafe` (the
code is invoked with the current page as its single argument):

```js
async (page) => {
  const session = await page.context().newCDPSession(page);
  const { targetId } = await session.send("Target.createTarget", {
    url: "https://admin.shopify.com",
    newWindow: true,
  });
  await session.detach();
  return targetId;
}
```

Then `browser_tabs` (action: list) and select the newly added entry — the
tab that was not in the list before creation (new tabs are appended at the
end); do not pick the first URL match, the developer may already have an
admin tab open.

**In all cases: save the targetId — step 5 closes the window with it.**

- Lands on a store dashboard (`admin.shopify.com/store/...`) → authenticated.
- Redirects to `accounts.shopify.com` login → tell the user: "Log into the
  Shopify admin in the verify window that just opened — the session
  persists." (profile mode: once per browser — each browser gets its own
  automation profile.) Wait for their confirmation, then re-check.

Keep the verify window open — the smoke test (step 5) reuses it.

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

1. In the verify window from step 3, navigate to
   `https://admin.shopify.com/store/<storeDomain>/apps/<appHandle>`.
2. Wait for the app iframe; take a screenshot; confirm the app rendered.
   - 404 → the app is not installed on this store; point the user to the dev
     server output's install link.
   - Iframe loads an error/tunnel page → dev server is down; the loop needs it
     running, but setup itself is complete.
3. Report the result and delete the screenshot.
4. Close the verify window with `browser_run_code_unsafe` and the targetId
   saved in step 3 (never `browser_close` or close-by-index — both act on
   the current tab and misfire when the developer has many tabs open; if the
   tool errors because its own page just closed, the window did close):

```js
async (page) => {
  const session = await page.context().newCDPSession(page);
  await session.send("Target.closeTarget", { targetId: "<targetId from step 3>" });
}
```
