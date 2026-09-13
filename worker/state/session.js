// worker/state/session.js
//
// Per-user "pending job" session, stored in Cloudflare KV (bound as
// env.STATE). Workers don't keep memory between invocations, so anything
// that needs to survive across multiple button taps (pick quality -> toggle
// rename -> toggle zip -> confirm start) has to live here.
//
// A session represents ONE job the user is currently configuring, from the
// moment a link/forward is recognised until they press "شروع پردازش".
// It's intentionally short-lived (1 hour TTL) — this is a UI scratchpad,
// not a job history (see history.js for that, once it exists).

const SESSION_TTL_SECONDS = 3600;

function key(userId) {
  return `session:${userId}`;
}

/**
 * @typedef {Object} JobSession
 * @property {"aparat"|"telegram"} source
 * @property {string} link                 - the resolved source link (aparat page or t.me link)
 * @property {string|null} quality         - only relevant for source === "aparat"
 * @property {boolean} rename              - whether the user wants to rename the output file
 * @property {string|null} customName      - the name they typed, once provided
 * @property {boolean} zip                 - whether to zip the output before uploading
 * @property {"picking_quality"|"awaiting_name"|"menu"|"confirmed"} stage
 */

export async function createSession(env, userId, session) {
  const full = {
    rename: false,
    customName: null,
    zip: false,
    quality: null,
    stage: "menu",
    ...session,
  };
  await env.STATE.put(key(userId), JSON.stringify(full), { expirationTtl: SESSION_TTL_SECONDS });
  return full;
}

export async function getSession(env, userId) {
  const raw = await env.STATE.get(key(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function updateSession(env, userId, patch) {
  const current = await getSession(env, userId);
  if (!current) return null;
  const next = { ...current, ...patch };
  await env.STATE.put(key(userId), JSON.stringify(next), { expirationTtl: SESSION_TTL_SECONDS });
  return next;
}

export async function clearSession(env, userId) {
  await env.STATE.delete(key(userId));
}
