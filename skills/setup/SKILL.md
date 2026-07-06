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
