// Vercel's Node runtime calls a handler as `(req, res)` — Node's own
// IncomingMessage and ServerResponse, not the Web `Request`/`Response` pair.
//
// Returning a `Response` object from such a handler does nothing at all. The
// runtime is waiting for `res.end()`, the handler never calls it, and the
// request hangs until the gateway gives up. That is not a 500 and not a 404:
// the route answers nothing, which looks exactly like a function that was
// never deployed. It cost two wrong diagnoses and two merged PRs before
// `/api/nonexistent` returning a fast 404 while `/api/session` hung proved the
// functions were there all along.
//
// So the handlers speak Node, and these adapters keep the rest of the code
// working in the vocabulary it was written and tested in: `auth.mjs` takes
// something with `.headers.get()`, which is worth preserving because its tests
// exercise it with real `Request` objects.

// A minimal stand-in for the parts of `Request` that auth.mjs actually reads.
// Node lowercases incoming header names, and `Headers.get()` is case
// insensitive, so this matches on lowercase.
export function requestLike(req) {
  return {
    method: req.method,
    headers: {
      get(name) {
        const value = req.headers[String(name).toLowerCase()];
        return value === undefined ? null : Array.isArray(value) ? value.join(", ") : value;
      },
    },
  };
}

// Read and parse a JSON body. Vercel may have parsed it already; when it has
// not, the raw stream is still there. Bounded, because an unbounded read on a
// public endpoint is a denial-of-service waiting to happen.
export async function readJson(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object") return req.body;

  const raw = await readText(req, { maxBytes });
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function readText(req, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof req.body === "string") return req.body;

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("body too large");
      error.code = "too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// One place that ends a response, so no route can forget to.
export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}
