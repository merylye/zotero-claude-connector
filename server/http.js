// http.js — HTTP transport for the Zotero clients.
//
// Why this exists instead of global fetch(): fetch pools keep-alive sockets and enforces no
// overall deadline on a response. When Zotero has been running for a long time, a pooled socket
// to its local API can be left half-open, and the next request on it waits forever with no error.
// That is the hang that used to be cleared only by quitting and reopening Zotero.
//
// Every request here opens a fresh connection and carries a hard deadline covering connect,
// headers and body. A stalled request fails in seconds with a message that says what to do.

import http from "node:http";
import https from "node:https";

const localAgent = new http.Agent({ keepAlive: false, maxSockets: 6 });
const webAgent = new https.Agent({ keepAlive: false, maxSockets: 6 });

export class HttpTimeout extends Error {
  constructor(ms) {
    super(`No response within ${Math.round(ms / 1000)}s`);
    this.name = "HttpTimeout";
    this.code = "ETIMEDOUT_DEADLINE";
    this.timeoutMs = ms;
  }
}

function responseLike(status, headers, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => body,
    json: async () => (body ? JSON.parse(body) : null),
  };
}

export function rawRequest(urlStr, opts = {}) {
  const {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 20000,
    followRedirects = true,
    _depth = 0,
  } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(arg);
    };
    const fail = (e) => {
      finish(reject, e);
      try {
        req?.destroy();
      } catch {
        /* already gone */
      }
    };

    const deadline = setTimeout(() => fail(new HttpTimeout(timeoutMs)), timeoutMs);

    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return fail(e);
    }
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;

    req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: { ...headers, connection: "close" },
        agent: isHttps ? webAgent : localAgent,
      },
      (res) => {
        const loc = res.headers.location;
        const redirect = [301, 302, 303, 307, 308].includes(res.statusCode);
        if (followRedirects && redirect && loc && _depth < 5) {
          let next = null;
          try {
            next = new URL(loc, urlStr).toString();
          } catch {
            next = null;
          }
          // Only http(s) is followed. Zotero's /file endpoint redirects to a file:// URL, which
          // the caller wants to read off the Location header rather than follow.
          if (next && /^https?:/i.test(next)) {
            res.resume();
            settled = true;
            clearTimeout(deadline);
            rawRequest(next, { ...opts, _depth: _depth + 1 }).then(resolve, reject);
            return;
          }
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          finish(resolve, responseLike(res.statusCode, res.headers, Buffer.concat(chunks).toString("utf8")))
        );
        res.on("error", fail);
      }
    );

    // Second line of defence: socket goes quiet without the deadline having elapsed.
    req.setTimeout(timeoutMs, () => fail(new HttpTimeout(timeoutMs)));
    req.on("error", fail);
    if (body != null) req.write(body);
    req.end();
  });
}

const TRANSIENT = new Set(["ETIMEDOUT_DEADLINE", "ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "EAI_AGAIN"]);

export function isTransient(e) {
  return e instanceof HttpTimeout || TRANSIENT.has(e?.code);
}

// GETs are safe to repeat, so one stale socket or one stalled read is retried transparently.
// Writes are never retried automatically, to avoid applying a change twice.
export async function requestWithRetry(urlStr, opts = {}) {
  const method = opts.method || "GET";
  const retries = method === "GET" ? 1 : 0;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await rawRequest(urlStr, opts);
    } catch (e) {
      last = e;
      if (!isTransient(e) || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw last;
}
