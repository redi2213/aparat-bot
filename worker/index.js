// worker/index.js
//
// Cloudflare Worker entry point. Handles two kinds of incoming requests:
//   1. POST /            - Telegram webhook -> GitHub repository_dispatch
//   2. POST /internal/history-add - called by GitHub Actions after a job
//      finishes successfully, to record it in the user's history. This
//      exists because Actions has no direct access to Cloudflare KV; this
//      endpoint is the only bridge, gated by a shared secret (not the
//      Telegram webhook secret — a separate one, since this is a
//      completely different caller).
//
// This file is intentionally thin — it only verifies requests and routes
// them to the right handler. All logic lives in the sibling modules:
//   telegram/client.js    - raw Telegram Bot API calls
//   telegram/forward.js   - forwarded-message / media detection
//   telegram/menus.js     - inline keyboard / menu text definitions
//   telegram/handlers.js  - message & callback routing logic
//   github/dispatch.js    - repository_dispatch calls to GitHub Actions
//   state/session.js      - per-user in-progress job configuration (Cloudflare KV)
//   state/activeJob.js    - currently-running GitHub Actions job, for the cancel button (Cloudflare KV)
//   state/users.js        - admin/allowed-user access control (Cloudflare KV)
//   state/history.js      - per-user completed-job history (Cloudflare KV)
//
// Required environment variables / secrets (synced automatically on every
// deploy by .github/workflows/deploy-worker.yml from GitHub repo secrets —
// set/update them under Settings -> Secrets and variables -> Actions,
// no `wrangler secret put` needed):
//   TELEGRAM_TOKEN   - Bot token from @BotFather for @aparaat_dl_bot
//   USER_ID          - Your numeric Telegram user id (the admin)
//   GH_TOKEN         - GitHub Personal Access Token with 'repo' scope
//   WEBHOOK_SECRET   - Random string, used to verify requests really come from Telegram
//   INTERNAL_SECRET  - Random string, used to verify /internal/* requests really come from our own GitHub Actions
//
// Bound KV namespace (set in wrangler.toml):
//   STATE            - see state/session.js, state/users.js, state/history.js

import { handleMessage, handleCallback } from "./telegram/handlers.js";
import { addHistoryEntry } from "./state/history.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/history-add") {
      return handleHistoryAdd(request, env);
    }

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
        await handleMessage(update.message, env, ctx);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env, ctx);
      }
    } catch (err) {
      console.error("Handler error:", err);
    }

    // Always return 200 quickly so Telegram doesn't retry/backoff on us.
    return new Response("OK", { status: 200 });
  },
};

/**
 * Called by actions/common/notify.py (record_history) once a job finishes
 * successfully. Body shape:
 *   { userId, source, fileName, fileSize, link }
 * Auth is a simple shared-secret header, not the Telegram webhook secret —
 * this caller is GitHub Actions, not Telegram.
 */
async function handleHistoryAdd(request, env) {
  const secretHeader = request.headers.get("X-Internal-Secret");
  if (secretHeader !== env.INTERNAL_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { userId, source, fileName, fileSize, link } = body || {};
  if (!userId || !source || !link) {
    return new Response("Missing required fields", { status: 400 });
  }

  try {
    await addHistoryEntry(env, userId, {
      source,
      fileName: fileName || null,
      fileSize: fileSize || null,
      link,
    });
    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("history-add error:", err);
    return new Response("Internal Error", { status: 500 });
  }
}
