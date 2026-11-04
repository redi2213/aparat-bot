// worker/storage/delete.js
//
// Really deletes a history entry's file from wherever it is stored:
//   - GitHub : the Release (and its tag) the file was uploaded to
//   - Arvan  : the object in the S3 bucket
//
// Before this module existed the bot's 🗑 button only removed the entry from
// the KV history list; the file itself stayed in the Release / bucket.
//
// Contract: returns { ok, storage, detail }. ok === true means the file is
// confirmed gone (or was already gone). ok === false means it may still
// exist, and the caller must NOT drop the history entry in that case.

import { isAdmin, getUserRecord, getAdminRecord } from "../state/users.js";
import { providerKeyFields, DEFAULT_INTERNAL_PROVIDER_ID } from "../state/storageProviders.js";
import { s3DeleteObject } from "./s3.js";
import {
  STORAGE_GITHUB,
  STORAGE_ARVAN,
  BOT_TAG_RE,
  detectStorage,
  parseReleaseTag,
  parseS3Link,
} from "./detect.js";

const REPO = "redi2213/aparat-bot";

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "aparat-bot-worker",
  };
}

async function deleteGithubRelease(env, tag) {
  if (!BOT_TAG_RE.test(tag)) {
    return { ok: false, detail: `تگ «${tag}» مال این ربات نیست، دست نمی‌زنم.` };
  }

  const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: ghHeaders(env),
  });
  if (rel.status === 404) return { ok: true, detail: "قبلاً حذف شده بود" };
  if (!rel.ok) return { ok: false, detail: `GitHub ${rel.status}` };

  const { id } = await rel.json();
  const del = await fetch(`https://api.github.com/repos/${REPO}/releases/${id}`, {
    method: "DELETE",
    headers: ghHeaders(env),
  });
  if (del.status !== 204 && del.status !== 404) return { ok: false, detail: `GitHub ${del.status}` };

  // Deleting a release leaves its git tag behind — remove it too so the
  // repo doesn't accumulate dead tags. A failure here is harmless.
  await fetch(`https://api.github.com/repos/${REPO}/git/refs/tags/${encodeURIComponent(tag)}`, {
    method: "DELETE",
    headers: ghHeaders(env),
  }).catch(() => {});

  return { ok: true, detail: "" };
}

/**
 * Credential sets that might be able to delete this entry's S3 object, in
 * the order worth trying: the same key the upload used first. (Admin key =
 * shared bucket owner; personal key = the user's own account.)
 */
async function candidateCredentials(env, ownerId, usedPersonalKey) {
  const f = providerKeyFields(DEFAULT_INTERNAL_PROVIDER_ID);
  const sets = [];

  const personalRec = isAdmin(ownerId, env) ? null : await getUserRecord(env, ownerId);
  const adminRec = await getAdminRecord(env);

  const personal =
    personalRec && personalRec[f.accessKey] && personalRec[f.secretKey]
      ? { accessKey: personalRec[f.accessKey], secretKey: personalRec[f.secretKey] }
      : null;
  const admin =
    adminRec && adminRec[f.accessKey] && adminRec[f.secretKey]
      ? { accessKey: adminRec[f.accessKey], secretKey: adminRec[f.secretKey] }
      : null;

  const ordered = usedPersonalKey === true ? [personal, admin] : [admin, personal];
  for (const c of ordered) {
    if (c && !sets.some((s) => s.accessKey === c.accessKey)) sets.push(c);
  }
  return sets;
}

async function deleteArvanObject(env, entry, ownerId) {
  const parsed = parseS3Link(entry.link);
  if (!parsed) return { ok: false, detail: "لینک فایل قابل تشخیص نیست." };

  const creds = await candidateCredentials(env, ownerId, entry.usedPersonalKey);
  if (creds.length === 0) return { ok: false, detail: "کلید آروان تنظیم نشده (نه شخصی، نه ادمین)." };

  let last = null;
  for (const c of creds) {
    const r = await s3DeleteObject({
      endpoint: parsed.endpoint,
      bucket: parsed.bucket,
      key: parsed.key,
      accessKey: c.accessKey,
      secretKey: c.secretKey,
    });
    if (r.ok) return { ok: true, detail: "" };
    last = r;
    // Wrong key for this bucket -> try the next set; anything else
    // (network, 5xx) won't be fixed by another key.
    if (r.status !== 403 && r.status !== 401) break;
  }
  return { ok: false, detail: last ? last.detail : "ناموفق" };
}

/**
 * @param {object} entry     a history entry (see state/history.js)
 * @param {string} ownerId   the user id whose history the entry lives in
 */
export async function deleteFromStorage(env, entry, ownerId) {
  const storage = detectStorage(entry);

  try {
    if (storage === STORAGE_GITHUB) {
      const tag = parseReleaseTag(entry.link);
      if (!tag) return { ok: false, storage, detail: "تگ ریلیز از لینک پیدا نشد." };
      const r = await deleteGithubRelease(env, tag);
      return { ok: r.ok, storage, detail: r.detail };
    }
    if (storage === STORAGE_ARVAN) {
      const r = await deleteArvanObject(env, entry, ownerId);
      return { ok: r.ok, storage, detail: r.detail };
    }
  } catch (err) {
    return { ok: false, storage, detail: err && err.message ? err.message : String(err) };
  }

  return { ok: false, storage: null, detail: "محل ذخیره‌ی فایل مشخص نیست." };
}
