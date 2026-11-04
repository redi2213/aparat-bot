// worker/index.js
//
// Cloudflare Worker entry point. Handles two kinds of incoming requests:
//   1. POST /            - Telegram webhook -> GitHub repository_dispatch
//   0. GET /dl/<tag>/<name>?s=<sig> and POST /app/sign - signed file links (see download.js)
//   3. POST /internal/history-purge - called by actions/empty_storage after it wipes a storage, to drop dangling history entries.
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
import { addHistoryEntry, purgeHistoryByStorage } from "./state/history.js";
import { isAdmin, recordUsage, listUsers } from "./state/users.js";
import { detectStorage, STORAGE_GITHUB, STORAGE_ARVAN } from "./storage/detect.js";
import { handleDownload, handleAppSign } from "./download.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Signed download links of the (private) repo's release files, and their signing for the YT Bridge app.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/dl/")) {
      return handleDownload(request, env);
    }
    if (request.method === "POST" && url.pathname === "/app/sign") {
      return handleAppSign(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/history-add") {
      return handleHistoryAdd(request, env);
    }

    if (request.method === "POST" && url.pathname === "/internal/history-purge") {
      return handleHistoryPurge(request, env);
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
 *   { userId, source, fileName, fileSize, link, storageKind, usedPersonalKey }
 * Auth is a simple shared-secret header, not the Telegram webhook secret —
 * this caller is GitHub Actions, not Telegram.
 *
 * storageKind ("internal" | "external" | null/omitted) and usedPersonalKey
 * drive quota accounting (see state/users.js recordUsage): a personal-key
 * internal upload never counts against the admin-backed internal quota,
 * since the user's own provider account was billed, not the admin's.
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

  const { userId, source, fileName, fileSize, link, storageKind, usedPersonalKey } = body || {};
  if (!userId || !source || !link) {
    return new Response("Missing required fields", { status: 400 });
  }

  try {
    // Remember where the file physically lives, so the bot can show it in
    // the history list and later delete it from the right place.
    const storage =
      storageKind === "internal"
        ? STORAGE_ARVAN
        : storageKind === "external"
          ? STORAGE_GITHUB
          : detectStorage({ link });

    await addHistoryEntry(env, userId, {
      source,
      fileName: fileName || null,
      fileSize: fileSize || null,
      link,
      ...(storage ? { storage } : {}),
      ...(storage === STORAGE_ARVAN ? { usedPersonalKey: !!usedPersonalKey } : {}),
    });

    if (storageKind === "internal" || storageKind === "external") {
      const admin = isAdmin(userId, env);
      // A personal-key internal upload bypasses the internal quota
      // entirely — see resolveStorageCredentials in handlers.js and the
      // recordUsage doc comment in state/users.js.
      const skipUsage = storageKind === "internal" && usedPersonalKey;
      if (!skipUsage) {
        await recordUsage(env, userId, storageKind, fileSize || 0, admin);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("history-add error:", err);
    return new Response("Internal Error", { status: 500 });
  }
}

/**
 * Called by actions/empty_storage/empty.py after it has really wiped a
 * storage ("github" | "arvan" | "all"). Removes the now-dangling entries
 * from every user's history. Body: { storage }.
 */
async function handleHistoryPurge(request, env) {
  if (request.headers.get("X-Internal-Secret") !== env.INTERNAL_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const which = body && body.storage;
  const storages =
    which === "all" ? [STORAGE_GITHUB, STORAGE_ARVAN] : which === STORAGE_GITHUB || which === STORAGE_ARVAN ? [which] : null;
  if (!storages) return new Response("Bad storage", { status: 400 });

  try {
    const users = await listUsers(env);
    const ids = [env.USER_ID, ...users.map((u) => u.id)];
    let removed = 0;
    for (const id of ids) removed += await purgeHistoryByStorage(env, id, storages);
    return new Response(JSON.stringify({ removed }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("history-purge error:", err);
    return new Response("Internal Error", { status: 500 });
  }
}
