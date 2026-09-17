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
// are they the admin, their personal storage-provider keys (if any), and
// their internal/external upload quotas".
//
// Quota model (see the handoff doc this was built from):
//   - "internal" = uploads that land on an S3-compatible provider (see
//     storageProviders.js) instead of GitHub Releases. Metered because
//     providers like ArvanCloud have real traffic costs.
//   - "external" = uploads that land on GitHub Releases (today's original
//     path). Free from our side, but the admin may still want a cap.
//   - Both quotas are `null` = unlimited by default. Usage resets monthly
//     (see maybeResetQuota below), tracked lazily on first use after the
//     reset date rather than via a cron job — simpler, and correct as long
//     as *some* request eventually comes in after the boundary.
//   - A user's own provider keys (arvanAccessKey/etc, see
//     storageProviders.js:providerKeyFields) bypass the *internal* quota
//     entirely, since they're spending their own account's traffic, not
//     the admin's. The external quota still applies to them if the admin
//     set one, since GitHub Release storage is shared infrastructure.
//
// The admin themselves is exempt from all quota checks (see isAdmin
// callers in handlers.js) — this file just stores/serves the numbers,
// enforcement is the caller's job (kept here would require importing
// isAdmin circularly for no real benefit).

const USERS_INDEX_KEY = "users:index"; // JSON array of {id, addedAt} for all non-admin allowed users
const ADMIN_KEYS_KEY = "users:admin_keys"; // admin's own storage-provider keys (see getAdminRecord)

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30 * MS_PER_DAY; // deliberately a plain 30-day cycle, not calendar-month — simpler and avoids edge cases (Feb, etc.) for a personal-bot-scale quota

function userKey(userId) {
  return `users:${userId}`;
}

function blankQuotaFields() {
  return {
    internalQuotaBytes: null,
    internalUsedBytes: 0,
    externalQuotaBytes: null,
    externalUsedBytes: 0,
    quotaResetAt: Date.now() + MS_PER_MONTH,
  };
}

function blankProviderKeyFields() {
  // Flat, provider-prefixed fields (arvanAccessKey, arvanSecretKey, ...) so
  // adding a future provider is just adding more prefixed fields, not a
  // schema migration. See storageProviders.js:providerKeyFields for the
  // naming convention this follows.
  return {
    arvanAccessKey: null,
    arvanSecretKey: null,
    arvanEndpoint: null,
    arvanBucket: null,
  };
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
 *
 * quotas, if given, seeds { internalQuotaBytes, externalQuotaBytes } —
 * leave a field undefined/null for unlimited.
 */
export async function addUser(env, userId, quotas = {}) {
  if (isAdmin(userId, env)) {
    return { added: false, alreadyExists: true, isAdmin: true };
  }

  const existing = await env.STATE.get(userKey(userId));
  if (existing !== null) {
    return { added: false, alreadyExists: true, isAdmin: false };
  }

  const addedAt = Date.now();
  const record = {
    id: userId,
    addedAt,
    ...blankQuotaFields(),
    ...blankProviderKeyFields(),
    internalQuotaBytes: quotas.internalQuotaBytes ?? null,
    externalQuotaBytes: quotas.externalQuotaBytes ?? null,
  };
  await env.STATE.put(userKey(userId), JSON.stringify(record));

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
 * Lists all non-admin allowed users (admin isn't stored in KV under this
 * index, so isn't included here — callers that want "everyone" should
 * show the admin separately, e.g. as "شما (ادمین)").
 */
export async function listUsers(env) {
  return getIndex(env);
}

// ---------------------------------------------------------------------------
// Full user record (quotas + personal provider keys)
//
// getIndex()/listUsers() above stay lightweight ({id, addedAt} only) since
// they're used for menu listings; the functions below deal with the full
// per-user record for quota checks and key management.

/**
 * Returns the full stored record for a regular (non-admin) user, applying
 * the lazy monthly quota reset if the reset date has passed. Returns null
 * if the user isn't in the allow-list at all.
 */
export async function getUserRecord(env, userId) {
  const raw = await env.STATE.get(userKey(userId));
  if (!raw) return null;

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }

  // Backfill fields for records created before quotas/keys existed (e.g.
  // users added before this feature shipped) — never break on an old shape.
  record = { ...blankQuotaFields(), ...blankProviderKeyFields(), ...record };

  return maybeResetQuota(env, userId, record);
}

async function maybeResetQuota(env, userId, record) {
  if (!record.quotaResetAt || Date.now() < record.quotaResetAt) {
    return record;
  }
  const reset = {
    ...record,
    internalUsedBytes: 0,
    externalUsedBytes: 0,
    quotaResetAt: Date.now() + MS_PER_MONTH,
  };
  await env.STATE.put(userKey(userId), JSON.stringify(reset));
  return reset;
}

/**
 * Admin's own record — kept in its own KV key rather than users:<id>, since
 * the admin isn't in the regular allow-list. Only ever holds provider keys
 * today (the admin has no quota to track), but shares the same blank-field
 * shape so providerKeyFields()-based code doesn't need an admin/user branch.
 */
export async function getAdminRecord(env) {
  const raw = await env.STATE.get(ADMIN_KEYS_KEY);
  let record = {};
  if (raw) {
    try {
      record = JSON.parse(raw);
    } catch {
      record = {};
    }
  }
  return { ...blankProviderKeyFields(), ...record };
}

export async function updateAdminRecord(env, patch) {
  const current = await getAdminRecord(env);
  const next = { ...current, ...patch };
  await env.STATE.put(ADMIN_KEYS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Merges `patch` into a regular user's record (provider keys, quotas,
 * whatever). Returns the updated record, or null if the user doesn't exist.
 * Does not create a user — use addUser for that.
 */
export async function updateUserRecord(env, userId, patch) {
  const current = await getUserRecord(env, userId);
  if (!current) return null;
  const next = { ...current, ...patch };
  await env.STATE.put(userKey(userId), JSON.stringify(next));
  return next;
}

/**
 * Sets a regular user's quota caps. Pass null (or omit) for unlimited on
 * either field. Returns the updated record, or null if the user doesn't exist.
 */
export async function setUserQuotas(env, userId, { internalQuotaBytes, externalQuotaBytes } = {}) {
  const patch = {};
  if (internalQuotaBytes !== undefined) patch.internalQuotaBytes = internalQuotaBytes;
  if (externalQuotaBytes !== undefined) patch.externalQuotaBytes = externalQuotaBytes;
  return updateUserRecord(env, userId, patch);
}

/**
 * Records `bytes` of usage against a user's internal or external quota.
 * Safe to call for the admin too — it's just a no-op in that case, since
 * the admin has no stored record/quota to update.
 */
export async function recordUsage(env, userId, kind, bytes, isAdminUser) {
  if (isAdminUser || !bytes) return;
  const field = kind === "internal" ? "internalUsedBytes" : "externalUsedBytes";
  const current = await getUserRecord(env, userId);
  if (!current) return;
  await updateUserRecord(env, userId, { [field]: (current[field] || 0) + bytes });
}

/**
 * Checks whether `bytes` more usage would fit within the given quota kind
 * for this user. Admin always passes (unlimited). A user with no stored
 * record (shouldn't normally happen — they must be allow-listed to reach
 * this point) also passes, rather than blocking on a data inconsistency.
 *
 * @returns {Promise<{allowed: boolean, remainingBytes: number|null}>} remainingBytes is null when unlimited
 */
export async function checkQuota(env, userId, kind, bytes, isAdminUser) {
  if (isAdminUser) return { allowed: true, remainingBytes: null };

  const record = await getUserRecord(env, userId);
  if (!record) return { allowed: true, remainingBytes: null };

  const quotaField = kind === "internal" ? "internalQuotaBytes" : "externalQuotaBytes";
  const usedField = kind === "internal" ? "internalUsedBytes" : "externalUsedBytes";

  const quota = record[quotaField];
  if (quota === null || quota === undefined) {
    return { allowed: true, remainingBytes: null }; // unlimited
  }

  const used = record[usedField] || 0;
  const remaining = Math.max(0, quota - used);

  // If we don't yet know the file's size (bytes is null/0), allow it —
  // we can't pre-check what we don't know, and the alternative (blocking
  // every unknown-size job) would defeat the point of the internal path
  // for exactly the cases (forwards, streamed URLs) where size isn't known
  // up front. Usage still gets recorded accurately after the fact via
  // recordUsage, using the real final file size.
  if (!bytes) return { allowed: true, remainingBytes: remaining };

  return { allowed: bytes <= remaining, remainingBytes: remaining };
}
