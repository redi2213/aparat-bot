// worker/index.js
//
// Cloudflare Worker entry point: Telegram webhook -> GitHub repository_dispatch
//
// This file is intentionally thin — it only verifies the request and routes
// it to the right handler. All logic lives in the sibling modules:
//   telegram/client.js    - raw Telegram Bot API calls
//   telegram/forward.js   - forwarded-message / media detection
//   telegram/menus.js     - inline keyboard / menu text definitions
//   telegram/handlers.js  - message & callback routing logic
//   github/dispatch.js    - repository_dispatch calls to GitHub Actions
//   state/session.js      - per-user in-progress job configuration (Cloudflare KV)
//
// Required environment variables / secrets (synced automatically on every
// deploy by .github/workflows/deploy-worker.yml from GitHub repo secrets —
// set/update them under Settings -> Secrets and variables -> Actions,
// no `wrangler secret put` needed):
//   TELEGRAM_TOKEN   - Bot token from @BotFather for @aparaat_dl_bot
//   USER_ID          - Your numeric Telegram user id (only this user is allowed)
//   GH_TOKEN         - GitHub Personal Access Token with 'repo' scope
//   WEBHOOK_SECRET   - Random string, used to verify requests really come from Telegram
//
// Bound KV namespace (set in wrangler.toml):
//   STATE            - see state/session.js

import { handleMessage, handleCallback } from "./telegram/handlers.js";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    // Verify the request actually came from Telegram, not just anyone who
    // finds this URL. Telegram echoes back the secret token we set with
    // setWebhook in this header on every request.
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    try {
      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error("Handler error:", err);
    }

    // Always return 200 quickly so Telegram doesn't retry/backoff on us.
    return new Response("OK", { status: 200 });
  },
};
