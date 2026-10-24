// Personal web proxy for Cloudflare Workers.
// Needs a secret named PROXY_KEY. Open https://<worker>.workers.dev/?key=<PROXY_KEY> once to log in.
// Cookies of target sites are kept in HttpOnly cookies named ck__<domain>__<name>, and are only sent back to that domain.
// Cookies that a site's own JavaScript sets (document.cookie) are not supported.

const AUTH = 'pk';
const BASE = 'pb';
const JAR = 'ck__';
const DROP = ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie', 'content-encoding', 'content-length', 'strict-transport-security', 'report-to', 'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'permissions-policy'];

const HOME = `<!doctype html><html lang='fa' dir='rtl'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Web</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;background:#0f1115;color:#e8e8e8}input{width:100%;box-sizing:border-box;padding:14px;font-size:16px;border-radius:10px;border:1px solid #333;background:#1a1d24;color:inherit;direction:ltr}button{margin-top:10px;width:100%;padding:14px;font-size:16px;border:0;border-radius:10px;background:#2ea043;color:#fff}</style></head><body><h2>وب‌پروکسی</h2><form action='/go' method='get'><input name='q' placeholder='example.com یا عبارت جستجو' autofocus autocomplete='off' autocapitalize='off'><button>برو</button></form></body></html>`;

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      return text('Error: ' + ((e && e.message) || e), 502);
    }
  },
};

async function handle(request, env) {
  if (!env.PROXY_KEY) return text('Not configured', 503);
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie') || '');

  const key = url.searchParams.get('key');
  if (url.pathname === '/' && key !== null) {
    if (!(await same(key, env.PROXY_KEY))) return text('Not found', 404);
    return new Response(null, {
      status: 302,
      headers: {
        location: '/',
        'set-cookie': AUTH + '=' + encodeURIComponent(key) + '; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax',
        'cache-control': 'no-store',
      },
    });
  }

  if (!cookies[AUTH] || !(await same(dec(cookies[AUTH]), env.PROXY_KEY))) {
    return text('Not found', 404);
  }

  const p = url.pathname;
  if (p === '/') return page(HOME);
  if (p === '/go') return redirect(prox(normalize(url.searchParams.get('q') || '')));
  if (p === '/p') {
    const u = url.searchParams.get('u');
    return u ? proxy(unwrap(u), request) : text('Missing u', 400);
  }
  if (p === '/f') {
    const u = url.searchParams.get('__u');
    if (!u) return text('Missing', 400);
    let t;
    try { t = new URL(u); } catch (e) { return text('Bad URL', 400); }
    const q = new URLSearchParams(url.search);
    q.delete('__u');
    t.search = q.toString();
    return proxy(t.href, request);
  }
  // Root-relative requests made by scripts: send them to the last visited site
  const last = dec(cookies[BASE] || '');
  if (last) return proxy(last + p + url.search, request);
  return text('Not found', 404);
}

async function proxy(target, request) {
  let t;
  try { t = new URL(target); } catch (e) { return text('Bad URL', 400); }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') return text('Only http/https', 400);
  const host = t.hostname.toLowerCase();
  if (blocked(host, new URL(request.url).hostname)) return text('Blocked', 403);
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return text('Method not allowed', 405);

  const h = new Headers();
  for (const n of ['user-agent', 'accept', 'accept-language', 'range', 'content-type']) {
    const v = request.headers.get(n);
    if (v) h.set(n, v);
  }
  h.set('referer', t.origin + '/');
  if (method === 'POST') h.set('origin', t.origin);
  const ck = cookiesFor(host, parseCookies(request.headers.get('cookie') || ''));
  if (ck) h.set('cookie', ck);

  const init = { method: method, headers: h, redirect: 'manual' };
  if (method === 'POST') init.body = request.body;
  const resp = await fetch(t.href, init);

  if ([301, 302, 303, 307, 308].includes(resp.status) && resp.headers.get('location')) {
    let loc;
    try { loc = new URL(resp.headers.get('location'), t).href; } catch (e) { return text('Bad redirect', 502); }
    const rh = new Headers({ location: prox(loc), 'cache-control': 'no-store' });
    addJar(rh, resp, host);
    return new Response(null, { status: resp.status, headers: rh });
  }

  const out = new Headers(resp.headers);
  for (const n of DROP) out.delete(n);
  out.set('x-robots-tag', 'noindex');
  out.set('referrer-policy', 'no-referrer');
  addJar(out, resp, host);
  const type = (out.get('content-type') || '').toLowerCase();

  if (type.includes('text/html')) {
    out.append('set-cookie', BASE + '=' + encodeURIComponent(t.origin) + '; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax');
    return rewriter(t.href).transform(new Response(resp.body, { status: resp.status, headers: out }));
  }
  if (type.includes('text/css')) {
    return new Response(rewriteCss(await resp.text(), t.href), { status: resp.status, headers: out });
  }
  return new Response(resp.body, { status: resp.status, headers: out });
}

// ---- cookie jar ----

function encName(n) {
  return encodeURIComponent(n).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Cookie header for the target host, built from stored cookies of that domain (and its parents)
function cookiesFor(host, cookies) {
  const parts = [];
  for (const k of Object.keys(cookies)) {
    if (k.indexOf(JAR) !== 0) continue;
    const rest = k.slice(JAR.length);
    const i = rest.indexOf('__');
    if (i < 1) continue;
    const dom = rest.slice(0, i);
    if (host === dom || host.endsWith('.' + dom)) parts.push(dec(rest.slice(i + 2)) + '=' + cookies[k]);
  }
  return parts.join('; ');
}

// Turn one Set-Cookie from the target into a stored, HttpOnly cookie of ours
function jarSet(sc, host) {
  const parts = sc.split(';');
  const nv = parts[0];
  const eq = nv.indexOf('=');
  if (eq < 1) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  let dom = host, maxAge = null, expires = null;
  for (const a of parts.slice(1)) {
    const j = a.indexOf('=');
    const k = (j < 0 ? a : a.slice(0, j)).trim().toLowerCase();
    const v = j < 0 ? '' : a.slice(j + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^[.]/, '').toLowerCase();
      if (host === d || host.endsWith('.' + d)) dom = d;
    } else if (k === 'max-age') {
      maxAge = v;
    } else if (k === 'expires') {
      expires = v;
    }
  }
  let c = JAR + dom + '__' + encName(name) + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax';
  if (maxAge !== null) c += '; Max-Age=' + maxAge;
  else if (expires) c += '; Expires=' + expires;
  return c;
}

function addJar(headers, resp, host) {
  const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  for (const sc of list) {
    const c = jarSet(sc, host);
    if (c) headers.append('set-cookie', c);
  }
}

// ---- HTML / CSS rewriting ----

function rewriter(pageUrl) {
  let base = pageUrl;
  const abs = (v) => {
    if (!v) return null;
    v = v.trim();
    if (!v || v.charAt(0) === '#' || /^(javascript|data|mailto|tel|blob|about):/i.test(v)) return null;
    try { return new URL(v, base).href; } catch (e) { return null; }
  };
  const attr = (name) => ({
    element(el) {
      let a = abs(el.getAttribute(name));
      if (a && name === 'href') a = unwrap(a);
      if (a) el.setAttribute(name, prox(a));
      el.removeAttribute('integrity');
    },
  });
  return new HTMLRewriter()
    .on('base', { element(el) { const a = abs(el.getAttribute('href')); if (a) base = a; el.remove(); } })
    .on('a[href], link[href], area[href]', attr('href'))
    .on('img[src], script[src], iframe[src], frame[src], source[src], video[src], audio[src], embed[src], track[src], input[src]', attr('src'))
    .on('video[poster]', attr('poster'))
    .on('object[data]', attr('data'))
    .on('img[srcset], source[srcset]', {
      element(el) {
        const s = el.getAttribute('srcset') || '';
        el.setAttribute('srcset', s.split(',').map((part) => {
          const bits = part.trim().split(/\s+/);
          const a = abs(bits[0]);
          if (a) bits[0] = prox(a);
          return bits.join(' ');
        }).join(', '));
      },
    })
    .on('meta[http-equiv]', {
      element(el) {
        if ((el.getAttribute('http-equiv') || '').toLowerCase() !== 'refresh') return;
        const m = (el.getAttribute('content') || '').match(/^\s*(\d+)\s*;\s*url=(.+)$/i);
        if (!m) return;
        const a = abs(m[2].replace(/^['"]|['"]$/g, ''));
        if (a) el.setAttribute('content', m[1] + ';url=' + prox(a));
      },
    })
    .on('form', {
      element(el) {
        const method = (el.getAttribute('method') || 'get').toLowerCase();
        const raw = el.getAttribute('action');
        const a = raw && raw.trim() ? abs(raw) : pageUrl;
        if (!a) return;
        if (method === 'post') {
          el.setAttribute('action', prox(a));
        } else {
          el.setAttribute('action', '/f');
          el.prepend(`<input type='hidden' name='__u' value='${esc(a)}'>`, { html: true });
        }
      },
    });
}

function rewriteCss(css, base) {
  const fix = (u) => {
    u = u.trim().replace(/^['"]|['"]$/g, '');
    if (!u || /^(data:|blob:|#)/i.test(u)) return null;
    try { return prox(new URL(u, base).href); } catch (e) { return null; }
  };
  css = css.replace(/url\(\s*([^)]*?)\s*\)/gi, (m, u) => { const a = fix(u); return a ? 'url("' + a + '")' : m; });
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, u) => { const a = fix(u); return a ? '@import "' + a + '"' : m; });
  return css;
}

// Search engines wrap result links in their own redirect; go straight to the real site.
function unwrap(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase();
    if (host.endsWith('duckduckgo.com') && x.pathname.indexOf('/l/') === 0) {
      const real = x.searchParams.get('uddg');
      if (real) return real;
    }
  } catch (e) { /* keep original */ }
  return u;
}

function normalize(q) {
  q = q.trim();
  if (!q) return 'https://html.duckduckgo.com/html/';
  if (/^https?:[/][/]/i.test(q)) return q;
  if (!/\s/.test(q) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(q)) return 'https://' + q;
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
}

function blocked(host, self) {
  const h = host.toLowerCase();
  if (h === self.toLowerCase()) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':') || h.startsWith('[')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return true;
  }
  return false;
}

async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const A = new Uint8Array(x), B = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}

function parseCookies(s) {
  const o = {};
  for (const part of s.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return o;
}

function prox(u) { return '/p?u=' + encodeURIComponent(u); }
function dec(v) { try { return decodeURIComponent(v); } catch (e) { return v; } }
function esc(s) { return s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;'); }
function redirect(to) { return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } }); }
function text(msg, status) { return new Response(msg, { status: status || 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' } }); }
function page(body) { return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' } }); }
