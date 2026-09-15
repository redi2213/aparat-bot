// worker/telegram/directUrl.js
//
// Detection + a lightweight pre-check for plain http(s) links that point
// directly at a file on some other server (not a t.me link). We use a HEAD
// request to peek at Content-Length before committing to a full job, so we
// can reject oversized files early (per-role limit — see users.js for who
// counts as admin) without ever spending an Actions run on it.

const TELEGRAM_LINK_RE = /^https?:\/\/t\.me\//i;
const DIRECT_URL_RE = /^https?:\/\/[^\s]+$/i;

const ADMIN_MAX_BYTES = null; // no cap for the admin
const USER_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB for regular users

export function isDirectUrl(text) {
  return DIRECT_URL_RE.test(text) && !TELEGRAM_LINK_RE.test(text);
}

export function maxAllowedBytes(isAdmin) {
  return isAdmin ? ADMIN_MAX_BYTES : USER_MAX_BYTES;
}

/**
 * HEAD-checks the URL to find its size and whether the server accepts the
 * request at all, without downloading anything. Servers that don't support
 * HEAD or omit Content-Length are common — in that case we simply proceed
 * without a known size (checked again after download completes, in case
 * it turns out to be oversized) rather than blocking a legitimate link.
 *
 * @returns {Promise<{ok: boolean, size: number|null, fileName: string|null, error: string|null}>}
 */
export async function probeDirectUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });

    if (!res.ok) {
      return { ok: false, size: null, fileName: null, error: `سرور پاسخ ${res.status} داد` };
    }

    const lengthHeader = res.headers.get("Content-Length");
    const size = lengthHeader ? parseInt(lengthHeader, 10) : null;
    const fileName = extractFileName(url, res.headers.get("Content-Disposition"));

    return { ok: true, size: Number.isFinite(size) ? size : null, fileName, error: null };
  } catch (err) {
    // Network error, timeout, or the server refuses HEAD outright — don't
    // hard-fail the whole flow over this; let the download step find out
    // for real. We just won't have a size to pre-check against the cap.
    return { ok: true, size: null, fileName: null, error: null };
  }
}

function extractFileName(url, contentDisposition) {
  if (contentDisposition) {
    const match = /filename\*?=(?:UTF-8'')?"?([^;"\n]+)"?/i.exec(contentDisposition);
    if (match && match[1]) return decodeURIComponent(match[1].trim());
  }
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop();
    return last || null;
  } catch {
    return null;
  }
}
