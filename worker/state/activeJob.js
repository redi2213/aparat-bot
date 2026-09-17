// worker/state/activeJob.js
//
// Tracks the "currently running" GitHub Actions job for a user, so the
// cancel button (shown on the progress message) can find the right
// workflow run to cancel. This is distinct from session.js (which is a
// pre-dispatch configuration scratchpad, cleared the moment dispatch
// happens) — an active job starts existing right as dispatch fires and
// only goes away when the job finishes or is cancelled.
//
// TTL is generous (2 hours) since large files can take a while; stale
// entries just mean a "cancel" click on a long-finished job harmlessly
// no-ops (cancelWorkflowRun against an already-completed run simply fails
// silently on GitHub's side).

const ACTIVE_JOB_TTL_SECONDS = 7200;

function key(userId) {
  return `active_job:${userId}`;
}

/**
 * @typedef {Object} ActiveJob
 * @property {"telegram_download"|"direct_url_download"} eventType
 * @property {number|null} runId   - filled in once dispatchAndTrackRun locates it; null while still searching
 * @property {number} messageId    - the progress message, so cancel can edit it
 * @property {number} startedAt    - epoch ms, for showing "still looking for run" grace period
 */

export async function setActiveJob(env, userId, job) {
  await env.STATE.put(key(userId), JSON.stringify(job), { expirationTtl: ACTIVE_JOB_TTL_SECONDS });
}

export async function getActiveJob(env, userId) {
  const raw = await env.STATE.get(key(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function updateActiveJob(env, userId, patch) {
  const current = await getActiveJob(env, userId);
  if (!current) return null;
  const next = { ...current, ...patch };
  await env.STATE.put(key(userId), JSON.stringify(next), { expirationTtl: ACTIVE_JOB_TTL_SECONDS });
  return next;
}

export async function clearActiveJob(env, userId) {
  await env.STATE.delete(key(userId));
}
