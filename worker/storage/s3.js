// worker/storage/s3.js
//
// Minimal AWS Signature V4 client for S3-compatible providers (ArvanCloud),
// just enough to delete one object from inside the Worker. No SDK — Workers
// can't run boto3, and pulling in a full S3 SDK for a single DELETE isn't
// worth it. Uses Web Crypto only.
//
// Addressing is path-style ({endpoint}/{bucket}/{key}) and the signing
// region is "default", matching how actions/common/storage_upload.py talks
// to the same provider with boto3 (that path is known to work).

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data) {
  return toHex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

// RFC 3986 percent-encoding (what SigV4 requires): encodeURIComponent plus !'()*
function encodeSegment(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function encodeKeyPath(key) {
  return String(key).split("/").map(encodeSegment).join("/");
}

function amzDateNow() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260101T120000Z
}

/**
 * Returns the headers (authorization, x-amz-date, x-amz-content-sha256, …)
 * to send with a request. `path` must already be percent-encoded exactly as
 * it will be sent on the wire; `query` is an object of un-encoded params.
 */
export async function signS3Request({
  method,
  host,
  path,
  query = {},
  headers = {},
  payload = "",
  accessKey,
  secretKey,
  region = "default",
  amzDate = amzDateNow(),
}) {
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(payload);

  const all = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const lower = {};
  for (const [k, v] of Object.entries(all)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");

  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeSegment(k)}=${encodeSegment(query[k])}`)
    .join("&");

  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac("AWS4" + secretKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    ...lower,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/**
 * Deletes one object. S3 answers 204 whether or not the key existed, so a
 * 2xx means "it is not there any more". Any other status is reported as a
 * failure with the provider's own error code, never swallowed — silently
 * "deleting" nothing is exactly the bug this module exists to fix.
 *
 * @returns {Promise<{ok: boolean, status: number, detail: string}>}
 */
export async function s3DeleteObject({ endpoint, bucket, key, accessKey, secretKey }) {
  const base = new URL(endpoint);
  const path = `/${encodeSegment(bucket)}/${encodeKeyPath(key)}`;

  const signed = await signS3Request({
    method: "DELETE",
    host: base.host,
    path,
    accessKey,
    secretKey,
  });

  // `host` is set by fetch itself; sending it explicitly is not allowed.
  const { host: _host, ...sendHeaders } = signed;

  let res;
  try {
    res = await fetch(`${base.origin}${path}`, { method: "DELETE", headers: sendHeaders });
  } catch (err) {
    return { ok: false, status: 0, detail: `خطای شبکه: ${err && err.message ? err.message : err}` };
  }

  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, detail: "" };

  let body = "";
  try {
    body = await res.text();
  } catch {
    // ignore
  }
  const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || "";
  const message = (body.match(/<Message>([^<]*)<\/Message>/) || [])[1] || "";
  return { ok: false, status: res.status, detail: `${res.status}${code ? " " + code : ""}${message ? ": " + message : ""}` };
}
