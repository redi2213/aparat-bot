// worker/state/session.js
//
// Per-user "pending job" session, stored in Cloudflare KV (bound as
// env.STATE). Workers don't keep memory between invocations, so anything
// that needs to survive across multiple button taps (toggle rename ->
// toggle zip -> confirm start) has to live here.
//
// A session represents ONE job the user is currently configuring, from the
// moment a link/forward is recognised until they press "شروع پردازش".
// It's intentionally short-lived (1 hour TTL) — this is a UI scratchpad,
// not a job history (see history.js for that).

const SESSION_TTL_SECONDS = 3600;

function key(userId) {
  return `session:${userId}`;
}

/**
 * @typedef {Object} JobSession
 * @property {"telegram"|"direct_url"|"admin_flow"} source
 * @property {string} link                 - the resolved t.me link or direct http(s) URL (empty for admin_flow, and empty when using privateChatId/privateMessageId instead — see below)
 * @property {number|null} [privateChatId]    - set instead of `link` when the forward has no public t.me link: this chat's Bot-API id, fetched back over MTProto logged in as the bot itself (see actions/telegram_download/download.py, _run_bot_mtproto_download)
 * @property {number|null} [privateMessageId] - the forwarded message's own id within privateChatId, used the same way
 * @property {boolean} rename              - whether the user wants to rename the output file
 * @property {string|null} customName      - the name they typed, once provided
 * @property {boolean} zip                 - whether to zip the output before uploading
 * @property {"awaiting_name"|"menu"|"awaiting_add_user_id"|"awaiting_remove_user_id"|"confirmed"} stage
 * @property {{kind: "self"|"user"|"all", targetId?: string}} [historyScope] - admin-only: which history view is currently open (used by admin_flow sessions)
 */

export async function createSession(env, userId, session) {
  const full = {
    rename: false,
    customName: null,
