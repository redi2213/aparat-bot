// worker/storage/detect.js
//
// Tiny, dependency-free helpers that answer "where does this history entry's
// file actually live?" — GitHub Release or the internal S3 provider
// (ArvanCloud). Kept separate from delete.js so state/history.js and
// telegram/menus.js can use it without pulling in the S3/GitHub clients.
//
// New entries carry an explicit `storage` field (written by
// /internal/history-add). Older entries (saved before that field existed)
// are classified from their link, which is unambiguous:
//   - GitHub: <worker>/dl/<tag>/<name>?s=...   or  github.com/.../releases/download/<tag>/<name>
//   - Arvan : https://s3.<region>.arvanstorage.ir/<bucket>/<key>

export const STORAGE_GITHUB = "github";
export const STORAGE_ARVAN = "arvan";

// Tags created by the bot's own workflows (telegram-to-release.yml -> "tg-…",
// direct-url-to-release.yml -> "url-…"). Anything else in the repo's
// Releases (e.g. files the YT Bridge app made) is never touched.
export const BOT_TAG_RE = /^(tg|url)-\d{8}-\d{6}$/;

export function detectStorage(entry) {
  if (!entry) return null;
  if (entry.storage === STORAGE_GITHUB || entry.storage === STORAGE_ARVAN) return entry.storage;

  const link = String(entry.link || "");
  if (/\/dl\/[^/]+\/[^/]+/.test(link) || /github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(link)) {
    return STORAGE_GITHUB;
  }
  if (/arvanstorage\./i.test(link)) return STORAGE_ARVAN;
  if (entry.storageKind === "internal") return STORAGE_ARVAN;
  if (entry.storageKind === "external") return STORAGE_GITHUB;
  return null;
}

export function storageLabel(storage) {
  if (storage === STORAGE_GITHUB) return "🌍 GitHub";
  if (storage === STORAGE_ARVAN) return "🇮🇷 آروان";
  return "❔ نامشخص";
}

/** Extracts the release tag from a GitHub-stored entry's link, or null. */
export function parseReleaseTag(link) {
  const s = String(link || "");
  let m = s.match(/\/dl\/([^/?#]+)\/[^/?#]+/);
  if (!m) m = s.match(/\/releases\/download\/([^/?#]+)\//);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * Splits an S3 path-style public URL (endpoint/bucket/key) into its parts.
 * Mirrors _build_public_url() in actions/common/storage_upload.py.
 */
export function parseS3Link(link) {
  let u;
  try {
    u = new URL(String(link));
  } catch {
    return null;
  }
  const segs = u.pathname.split("/").filter((x) => x.length > 0);
  if (segs.length < 2) return null;
  try {
    return {
      endpoint: u.origin,
      bucket: decodeURIComponent(segs[0]),
      key: segs.slice(1).map(decodeURIComponent).join("/"),
    };
  } catch {
    return null;
  }
}
