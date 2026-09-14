// The one place the control plane decides who may do what.
//
// DC-2026-004 settled viewer authentication as a shared secret exchanged for a
// session cookie, and required the check to live at a single boundary so that
// replacing it with GitHub OAuth later is a contained change. This is that
// boundary. The store and the renderer do not get their own opinion; they ask
// here.
//
// Two credentials, deliberately distinct (DC-2026-003 + DC-2026-004):
//
//   HQ_VIEW_PASSWORD  gates READING the mirror  — held by the founder
//   HQ_WRITE_TOKEN    gates WRITING the mirror  — held by the factory machine
//
// Neither implies the other. Rotating one must not force rotating the other,
// which is why they are separate variables compared by separate functions, and
// why no code path ever falls back from one to the other.
//
// Sessions are stateless: a signed, expiring cookie. There is no session store
// to keep consistent across regions, and revocation is by rotating
// HQ_SESSION_SECRET, which invalidates every session at once. For a
// single-founder control plane that is the right trade; a multi-viewer design
// (Option C) would need real revocation and is explicitly out of scope.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "hq_session";

// Long enough not to nag, short enough that a forgotten open tab is not a
// standing grant.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Compare through a digest, not directly. timingSafeEqual throws on unequal
// lengths, and that throw is itself an oracle for the secret's length; hashing
// both sides first makes every comparison the same shape.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const key = randomBytes(32);
  const left = createHmac("sha256", key).update(a).digest();
  const right = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(left, right);
}

function required(name) {
  const value = process.env[name];
  // An unset credential must never mean "allow". A deployment missing its
  // configuration fails closed and says which variable is missing — without
  // ever echoing a value.
  if (!value) {
    const error = new Error(`${name} is not configured`);
    error.code = "unconfigured";
    throw error;
  }
  return value;
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession({ now = Date.now() } = {}) {
  const secret = required("HQ_SESSION_SECRET");
  const payload = Buffer.from(JSON.stringify({ exp: now + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const secret = required("HQ_SESSION_SECRET");
  const index = token.lastIndexOf(".");
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  if (!constantTimeEqual(signature, sign(payload, secret))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > now;
  } catch {
    return false;
  }
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(value, { maxAge = SESSION_TTL_MS / 1000 } = {}) {
  // SameSite=Strict because nothing legitimately links into this app from
  // elsewhere, and a mirror of company state is not something to hand out on a
  // cross-site navigation.
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// --- the two gates -------------------------------------------------------

export function passwordMatches(candidate) {
  return constantTimeEqual(candidate, required("HQ_VIEW_PASSWORD"));
}

export function isViewer(request) {
  return verifySession(readCookie(request, COOKIE_NAME));
}

export function isPublisher(request) {
  const header = request.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return constantTimeEqual(header.slice(prefix.length), required("HQ_WRITE_TOKEN"));
}

// A refusal says nothing about why. "wrong password" and "no such user" are the
// same answer here, and a 401 never reports which credential was checked.
export function refuse(status = 401) {
  return new Response(JSON.stringify({ error: status === 401 ? "unauthorized" : "forbidden" }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const SESSION_TTL = SESSION_TTL_MS;
