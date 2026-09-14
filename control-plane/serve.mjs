#!/usr/bin/env node
// Local preview of the deployed control plane. Node standard library only.
//
// This is a development convenience, not the deployment: on Vercel the static
// files are served by the platform and this file never runs. It exists so the
// page can be checked before it ships, which is the habit the empty deployment
// that started this campaign went without.
//
// Bound to loopback. Nothing in this repository may open a port to the network
// (SFD-2026-012: the factory machine is outbound-only).

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT || 3212);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function resolveRequest(urlPath) {
  // normalize() collapses ".." before the prefix check, so a traversal attempt
  // cannot escape publicDir by spelling the path differently.
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(join(publicDir, relative === "/" ? "index.html" : relative));
  if (candidate !== publicDir && !candidate.startsWith(publicDir + "/")) return null;
  try {
    if (statSync(candidate).isDirectory()) return resolveRequest(join(urlPath, "index.html"));
  } catch {
    return null;
  }
  return candidate;
}

createServer((request, response) => {
  const path = resolveRequest(new URL(request.url, "http://localhost").pathname);
  if (!path) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  const extension = path.slice(path.lastIndexOf("."));
  response.writeHead(200, {
    "content-type": TYPES[extension] || "application/octet-stream",
    // Matches the deployment: a mirror must never be read from cache, or the
    // page shows a snapshot older than the one it claims.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  createReadStream(path).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`control-plane preview on http://127.0.0.1:${port} (loopback only)`);
});
