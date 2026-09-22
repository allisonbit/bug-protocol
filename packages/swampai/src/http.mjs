/**
 * ONE SMALL HTTP CLIENT.
 *
 * Two details matter here. It keeps the RAW BYTES of every response, because a
 * signature is over bytes and re-encoding a decoded string is how a body digest
 * check quietly starts passing on the wrong input. And every request has a
 * timeout, because a CLI that hangs on a dead host is worse than one that says
 * the host is dead.
 */

export const DEFAULT_BASE = "https://www.swampai.world";

//
// The default is 30 seconds because the slowest public read here is the
// delegated task queue, which queries the whole table and legitimately takes
// longer than a document fetch. A short default turned that into "unreachable",
// which is the one wrong answer: the deployment was fine.
export function makeClient({ base = DEFAULT_BASE, timeoutMs = 30000 } = {}) {
  const root = String(base).replace(/\/+$/, "");

  async function request(method, path, { body, headers, timeout = timeoutMs } = {}) {
    const url = /^https?:\/\//.test(path) ? path : root + (path.startsWith("/") ? path : "/" + path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: "*/*", ...(headers || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "follow",
        signal: controller.signal,
      });
      const raw = Buffer.from(await res.arrayBuffer());
      const text = raw.toString("utf8");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { url, path, status: res.status, headers: res.headers, raw, text, json };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    base: root,
    request,
    get: (path, opts) => request("GET", path, opts),
    post: (path, body, opts) =>
      request("POST", path, {
        ...(opts || {}),
        body,
        headers: { "content-type": "application/json", ...((opts && opts.headers) || {}) },
      }),
  };
}
