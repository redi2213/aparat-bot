// worker/state/users.js
//
// Authorization model:
//   - env.USER_ID (a secret, set once at deploy time) is the ADMIN. This
//     never changes at runtime and always has full access — it's the
//     "root" identity, kept in secrets rather than KV so a misbehaving
//     flow can never accidentally revoke the owner's own access.
//   - Everyone else must be explicitly allow-listed by the admin, from
//     inside the bot itself (Settings -> Add user), and is stored in KV
//     as a regular user (not admin).
//
// This file owns that allow-list. It does NOT own the pending-job session
// (session.js) or the file history (history.js) — just "who is allowed in,
// and are they the admin".

const USERS_INDEX_KEY = "users:index"; // JSON array of {id, addedAt} for all non-admin allowed users

function userKey(userId) {
  return `users:${userId}`;
}

export function isAdmin(userId, env) {
  return String(userId) === String(env.USER_ID);
}

/**
 * True if this user is allowed to use the bot at all — the admin, or
 * anyone explicitly added to the allow-list.
 */
export async function isAuthorized(userId, env) {
  if (isAdmin(userId, env)) return true;
  const raw = await env.STATE.get(userKey(userId));
  return raw !== null;
}

async function getIndex(env) {
  const raw = await env.STATE.get(USERS_INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveIndex(env, list) {
  await env.STATE.put(USERS_INDEX_KEY, JSON.stringify(list));
}

/**
 * Adds a user to the allow-list. Returns { added: boolean, alreadyExists: boolean }.
 * Refuses to "add" the admin's own id as a regular user — they're already
 * covered by isAdmin() and don't need an entry.
 */
export async function addUser(env, userId) {
  if (isAdmin(userId, env)) {
    return { added: false, alreadyExists: true, isAdmin: true };
  }

  const existing = await env.STATE.get(userKey(userId));
  if (existing !== null) {
    return { added: false, alreadyExists: true, isAdmin: false };
  }

  const addedAt = Date.now();
  await env.STATE.put(userKey(userId), JSON.stringify({ id: userId, addedAt }));

  const index = await getIndex(env);
  index.push({ id: userId, addedAt });
  await saveIndex(env, index);

  return { added: true, alreadyExists: false, isAdmin: false };
}

export async function removeUser(env, userId) {
  const existing = await env.STATE.get(userKey(userId));
  if (existing === null) return false;

  await env.STATE.delete(userKey(userId));
  const index = await getIndex(env);
  await saveIndex(env, index.filter((u) => String(u.id) !== String(userId)));
  return true;
}

/**
 * Lists all non-admin allowed users (admin isn't stored in KV, so isn't
 * included here — callers that want "everyone" should show the admin
 * separately, e.g. as "شما (ادمین)").
 */
export async function listUsers(env) {
  return getIndex(env);
}
