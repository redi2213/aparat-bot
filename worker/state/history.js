// worker/state/history.js
//
// Per-user history of completed downloads, stored in Cloudflare KV. Each
// user (identified by their Telegram id) has their own list, capped at
// HISTORY_LIMIT entries — oldest entries fall off automatically when a
// new one pushes the list over the cap.
//
// This is deliberately separate from state/session.js: a session is a
// short-lived "configuring a job right now" scratchpad (1h TTL), while
// history is a durable (no TTL) record of jobs that actually finished.
// Nothing here is written until a job succeeds — failed/cancelled jobs
// don't get a history entry.
//
// The admin (env.USER_ID) can see everyone's history; regular users only
// see their own — see worker/telegram/handlers.js for how that's enforced.
// This module only stores/retrieves; it doesn't decide who's allowed to
// see what.

const HISTORY_LIMIT = 20;

function key(userId) {
  return `history:${userId}`;
}

/**
 * @typedef {Object} HistoryEntry
 * @property {string} id            - unique id (timestamp-based) for this entry, used for deletion
 * @property {"telegram"|"direct_url"} source
 * @property {string} fileName      - display name shown in the list
 * @property {number|null} fileSize - bytes, if known
 * @property {string} link          - the direct download / result link
 * @property {number} createdAt     - epoch ms
 */

export async function getHistory(env, userId) {
  const raw = await env.STATE.get(key(userId));
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Adds a completed job to the front of the user's history, trimming to
 * HISTORY_LIMIT. Returns the updated list.
 */
export async function addHistoryEntry(env, userId, entry) {
  const list = await getHistory(env, userId);

  const full = {
    id: `${Date.now()}`,
    createdAt: Date.now(),
    ...entry,
  };

  list.unshift(full);
  const trimmed = list.slice(0, HISTORY_LIMIT);

  await env.STATE.put(key(userId), JSON.stringify(trimmed));
  return trimmed;
}

export async function removeHistoryEntry(env, userId, entryId) {
  const list = await getHistory(env, userId);
  const next = list.filter((e) => e.id !== entryId);
  if (next.length === list.length) return false; // nothing removed
  await env.STATE.put(key(userId), JSON.stringify(next));
  return true;
}

export async function getHistoryEntry(env, userId, entryId) {
  const list = await getHistory(env, userId);
  return list.find((e) => e.id === entryId) || null;
}

export async function clearHistory(env, userId) {
  await env.STATE.delete(key(userId));
}
