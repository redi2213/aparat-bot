// worker/download.js
//
// Download links for the (private) repo's Release files, served by the Worker.
//
//   GET|HEAD /dl/<tag>/<file name>?s=<signature>
//       The signature is the first 32 hex chars of HMAC-SHA256(INTERNAL_SECRET, "<tag>/<file name>"),
//       made by the Actions workflows (same secret) or by /app/sign. Without a valid signature
//       the file is not served. The file is streamed from the GitHub release (GH_TOKEN), Range works.
//
//   POST /app/sign   (Authorization: token <GitHub token of the owner>)  body {"items":[{"tag","name"}]}
//       Returns {"links":[...]} so the YT Bridge app can show working links for the bot's files.
//       The GitHub token is checked against GitHub itself: only the repo owner is accepted.

const OWNER = "redi2213";
const REPO = `${OWNER}/aparat-bot`;
const UA = "aparat-bot-worker";
const enc = new TextEncoder();

async function sign(env, tag, name) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(String(env.INTERNAL_SECRET || "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${tag}/${name}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signedLink(origin, env, tag, name) {
  return `${origin}/dl/${tag}/${encodeURIComponent(name)}?s=${await sign(env, tag, name)}`;
}

export async function handleDownload(request, env) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/dl\/([^/]+)\/(.+)$/);
  if (!m) return new Response("Not found", { status: 404 });
  let tag, name;
  try {
    tag = decodeURIComponent(m[1]);
    name = decodeURIComponent(m[2]);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const given = url.searchParams.get("s") || "";
  if (!env.INTERNAL_SECRET || !safeEqual(given, await sign(env, tag, name))) {
    return new Response("Forbidden", { status: 403 });
  }

  const gh = { Authorization: `token ${env.GH_TOKEN}`, "User-Agent": UA, Accept: "application/vnd.github+json" };
  const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: gh });
  if (rel.status !== 200) return new Response("Not found", { status: 404 });
  const asset = ((await rel.json()).assets || []).find((a) => a.name === name);
  if (!asset) return new Response("Not found", { status: 404 });

  // The asset URL answers with a redirect to a temporary storage link: follow it by hand so the
  // GitHub token is not sent along, and pass the Range header (resume / seeking) to the real file.
  const first = await fetch(asset.url, { headers: { ...gh, Accept: "application/octet-stream" }, redirect: "manual" });
  let upstream = first;
  const location = first.headers.get("Location");
  if (first.status >= 300 && first.status < 400 && location) {
    const headers = {};
    const range = request.headers.get("Range");
    if (range) headers.Range = range;
    upstream = await fetch(location, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
  }
  if (!upstream.ok) return new Response("Upstream error", { status: 502 });

  const out = new Headers();
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  out.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  out.set("Cache-Control", "private, no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export async function handleAppSign(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^(?:Bearer|token)\s+(\S+)$/i);
  if (!m) return new Response("Unauthorized", { status: 401 });
  const who = await fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${m[1]}`, "User-Agent": UA, Accept: "application/vnd.github+json" },
  });
  if (who.status !== 200) return new Response("Unauthorized", { status: 401 });
  const login = String((await who.json()).login || "").toLowerCase();
  if (login !== OWNER) return new Response("Forbidden", { status: 403 });

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const items = Array.isArray(body && body.items) ? body.items.slice(0, 200) : [];
  const origin = new URL(request.url).origin;
  const links = await Promise.all(items.map((it) => signedLink(origin, env, String(it.tag), String(it.name))));
  return new Response(JSON.stringify({ links }), { headers: { "Content-Type": "application/json" } });
}
