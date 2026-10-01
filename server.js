#!/usr/bin/env node
// iframe-wall: serve a page of iframes and ANY site (any domain) from ONE origin, so the page can
// read each iframe's DOM (iframe.contentDocument) instead of hitting the same-origin wall.
//
//   GET /__wall/...              -> files from ./public (the wrapper page)
//   GET /__p/<host>/<path>       -> proxied to https://<host>/<path>
//   GET /__p/http:<host>/<path>  -> proxied to http://<host>/<path>   (plain http / local apps)
//   anything else                -> routed by the Referer (/__p/... page) so absolute paths such
//                                   as /static/app.js keep working; else to TARGET if set
//
// The proxy strips frame-blocking headers (X-Frame-Options, CSP, COOP/COEP/CORP), rewrites
// redirects, cookies and absolute URLs in HTML, and tunnels WebSocket upgrades.
//
// Dev tool: it is an open proxy, so it listens on 127.0.0.1 only. Don't expose it.
//
//   node server.js
//   PORT=8080 HOST=127.0.0.1 TARGET=http://localhost:3001 node server.js   # TARGET optional

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

function makeTarget(scheme, host) {
  const u = new URL(`${scheme}://${host}`);
  return { scheme, host: u.host, hostname: u.hostname, port: Number(u.port) || (scheme === "https" ? 443 : 80) };
}

let DEFAULT_TARGET = null;
if (process.env.TARGET) {
  const u = new URL(process.env.TARGET);
  DEFAULT_TARGET = makeTarget(u.protocol.slice(0, -1), u.host);
}

const prefixOf = (scheme, host) => `/__p/${scheme === "http" ? "http:" : ""}${host}`;

// "/__p/[http:]host[/path?query]" -> { t, path, bare } ; null if not a proxy URL
function parseProxy(url) {
  const m = /^\/__p\/(?:(https?):)?([^/?#]+)([^]*)$/.exec(url);
  if (!m) return null;
  try {
    const rest = m[3];
    return { t: makeTarget(m[1] || "https", m[2]), bare: rest === "" || rest[0] === "?",
             path: rest === "" ? "/" : rest[0] === "?" ? "/" + rest : rest };
  } catch { return null; }
}

// Which upstream does this request belong to?
function resolve(req) {
  const direct = parseProxy(req.url);
  if (direct) return direct;
  if (req.headers.referer) {
    try {
      const ref = new URL(req.headers.referer);
      const r = parseProxy(ref.pathname + ref.search);
      if (r) return { t: r.t, path: req.url };
    } catch {}
  }
  return DEFAULT_TARGET ? { t: DEFAULT_TARGET, path: req.url } : null;
}

// Rewrite an absolute / root-relative / protocol-relative URL so it goes through the proxy.
function toProxy(v, t, basePath = "/") {
  if (/^\/__(?:p|wall)(?:\/|$)/.test(v)) return v;
  if (!/^(?:\/|https?:)/i.test(v)) return v;
  let u;
  try { u = new URL(v, `${t.scheme}://${t.host}${basePath}`); } catch { return v; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return v;
  return prefixOf(u.protocol.slice(0, -1), u.host) + u.pathname + u.search + u.hash;
}

// Headers that would stop the page from being framed / working under another origin.
const DROP = ["x-frame-options", "content-security-policy", "content-security-policy-report-only",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "strict-transport-security"];

function fixCookie(c) {
  return c.replace(/;\s*Domain=[^;]*/i, "").replace(/;\s*Secure/i, "")
    .replace(/;\s*SameSite=[^;]*/i, "").replace(/;\s*Path=[^;]*/i, "") + "; Path=/";
}

function cleanHeaders(h, t, reqPath) {
  const out = { ...h };
  for (const k of DROP) delete out[k];
  if (out.location) out.location = toProxy(out.location, t, reqPath);
  if (out["set-cookie"]) out["set-cookie"] = out["set-cookie"].map(fixCookie);
  return out;
}

// Injected into every proxied HTML page: keeps fetch/XHR/WebSocket/window.open on the proxy.
function shim(t) {
  return `<script>(function(){var P=${JSON.stringify(prefixOf(t.scheme, t.host))},S=${JSON.stringify(t.scheme)};
function fix(u){if(typeof u!=="string"&&!(u instanceof URL))return u;u=String(u);
if(/^\\/__(p|wall)(\\/|$)/.test(u))return u;
if(/^\\/\\/[^/]/.test(u))u=S+":"+u;
if(u[0]==="/")return P+u;
var m=u.match(/^(https?):\\/\\/([^/?#]+)([^]*)$/i);
if(m&&m[1].toLowerCase()+"://"+m[2].toLowerCase()!==location.origin)
return "/__p/"+(m[1].toLowerCase()==="http"?"http:":"")+m[2]+(m[3]||"/");
return u}
var f=window.fetch;if(f)window.fetch=function(i,o){return f.call(this,fix(i),o)};
var x=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return x.apply(this,arguments)};
var w=window.open;window.open=function(u){arguments[0]=fix(u);return w.apply(this,arguments)};
var W=window.WebSocket;window.WebSocket=function(u,p){var m=String(u).match(/^(wss?):\\/\\/([^/?#]+)([^]*)$/i);
if(m&&m[2]!==location.host)u=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+"/__p/"+(m[1].toLowerCase()==="ws"?"http:":"")+m[2]+(m[3]||"/");
return p===undefined?new W(u):new W(u,p)};
window.WebSocket.prototype=W.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){window.WebSocket[k]=W[k]});
})();</script>`;
}

function rewriteHtml(html, t, reqPath) {
  html = html
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/(\s(?:src|href|action|formaction|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi,
      (_, a, q, v) => a + q + toProxy(v, t, reqPath) + q);
  const tag = shim(t);
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
}

function decoded(up) {
  const enc = (up.headers["content-encoding"] || "").toLowerCase();
  if (enc === "gzip") return up.pipe(zlib.createGunzip());
  if (enc === "br") return up.pipe(zlib.createBrotliDecompress());
  if (enc === "deflate") return up.pipe(zlib.createInflate());
  return up;
}

function serveWall(req, res) {
  const rel = decodeURIComponent(req.url.split("?")[0].replace(/^\/__wall\/?/, "")) || "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return res.writeHead(403).end("forbidden");
  fs.readFile(file, (err, body) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
}

function upstreamHeaders(req, t) {
  const h = { ...req.headers, host: t.host, "accept-encoding": "identity" };
  h.origin && (h.origin = `${t.scheme}://${t.host}`);
  if (h.referer) {
    try {
      const ref = new URL(h.referer);
      const r = parseProxy(ref.pathname + ref.search);
      h.referer = r ? `${r.t.scheme}://${r.t.host}${r.path}` : `${t.scheme}://${t.host}/`;
    } catch { delete h.referer; }
  }
  return h;
}

function forward(req, res) {
  const r = resolve(req);
  if (!r) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("iframe-wall: unknown route. Open /__wall/ or use /__p/<host>/<path>.");
  }
  if (r.bare) { res.writeHead(302, { Location: req.url.replace(/^(\/__p\/[^/?#]+)/, "$1/") }); return res.end(); }

  const { t, path: reqPath } = r;
  const lib = t.scheme === "https" ? https : http;
  const upstream = lib.request({
    hostname: t.hostname, port: t.port, method: req.method, path: reqPath,
    headers: upstreamHeaders(req, t), servername: t.hostname,
  }, (up) => {
    const headers = cleanHeaders(up.headers, t, reqPath);
    const ct = up.headers["content-type"] || "";
    const cs = (/charset=([^;]+)/i.exec(ct)?.[1] || "utf-8").trim().replace(/["']/g, "").toLowerCase();
    if (!/text\/html/i.test(ct) || (cs !== "utf-8" && cs !== "utf8")) {
      res.writeHead(up.statusCode, headers);
      return up.pipe(res);
    }
    const chunks = [];
    const body = decoded(up);
    body.on("data", (c) => chunks.push(c));
    body.on("error", () => res.destroy());
    body.on("end", () => {
      const out = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString("utf8"), t, reqPath));
      delete headers["content-encoding"];
      delete headers["transfer-encoding"];
      headers["content-length"] = out.length;
      res.writeHead(up.statusCode, headers);
      res.end(out);
    });
  });
  upstream.on("error", (err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`iframe-wall: ${t.scheme}://${t.host} is not reachable (${err.code || err.message}).`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) =>
  req.url.startsWith("/__wall") ? serveWall(req, res) : forward(req, res));

// WebSocket / HMR: pipe the raw upgrade through to the upstream (TLS when https)
server.on("upgrade", (req, socket, head) => {
  const r = resolve(req);
  if (!r) return socket.destroy();
  const { t, path: reqPath } = r;
  const onConnect = (up) => {
    const lines = [`${req.method} ${reqPath} HTTP/${req.httpVersion}`];
    const headers = upstreamHeaders(req, t);
    delete headers["accept-encoding"];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    up.write(head);
    up.pipe(socket).pipe(up);
  };
  const up = t.scheme === "https"
    ? tls.connect({ host: t.hostname, port: t.port, servername: t.hostname }, () => onConnect(up))
    : net.connect(t.port, t.hostname, () => onConnect(up));
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, HOST, () =>
  console.log(`iframe-wall: open http://${HOST}:${PORT}/__wall/   (proxy: /__p/<host>/<path>${
    DEFAULT_TARGET ? `, fallback ${DEFAULT_TARGET.scheme}://${DEFAULT_TARGET.host}` : ""})`));
