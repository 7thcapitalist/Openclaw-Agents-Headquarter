// The control plane's client. Two views: sign in, and the mirror's state.
//
// The server is the authority on both. Nothing here decides whether a viewer is
// allowed in — it asks /api/session and draws what it is told. A client that
// could grant itself the view would be a gate in the wrong place (DC-2026-004
// puts the check at one boundary, and that boundary is on the server).

const TIMEOUT_MS = 8000;

const els = {
  signin: document.getElementById("signin"),
  signinForm: document.getElementById("signin-form"),
  signinError: document.getElementById("signin-error"),
  signinSubmit: document.getElementById("signin-submit"),
  password: document.getElementById("password"),
  signOut: document.getElementById("sign-out"),
  state: document.getElementById("state"),
  eyebrow: document.getElementById("state-eyebrow"),
  title: document.getElementById("state-title"),
  body: document.getElementById("state-body"),
  mirror: document.getElementById("fact-mirror"),
  publisher: document.getElementById("fact-publisher"),
};

async function request(url, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: abort.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

function showSignIn(message) {
  els.signin.hidden = false;
  els.state.hidden = true;
  els.signOut.hidden = true;
  els.signinError.hidden = !message;
  if (message) els.signinError.textContent = message;
  els.password.focus();
}

function renderState({ eyebrow, title, body, mirror, publisher, stale = false }) {
  els.signin.hidden = true;
  els.state.hidden = false;
  els.signOut.hidden = false;
  els.eyebrow.textContent = eyebrow;
  els.title.textContent = title;
  els.body.textContent = body;
  els.mirror.textContent = mirror;
  els.publisher.textContent = publisher;
  els.state.classList.toggle("is-stale", stale);
}

function age(publishedAt) {
  const then = Date.parse(publishedAt);
  if (Number.isNaN(then)) return "unknown age";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

async function loadMirror() {
  let response;
  try {
    response = await request("/api/mirror");
  } catch {
    renderState({
      eyebrow: "Offline",
      title: "The control plane could not be reached.",
      body:
        "Headquarters itself is unaffected — it runs on the factory machine " +
        "and this view is a mirror of it.",
      mirror: "unreachable",
      publisher: "unknown",
      stale: true,
    });
    return;
  }

  if (response.status === 401) {
    showSignIn("That session has expired. Sign in again.");
    return;
  }

  if (response.status === 404) {
    renderState({
      eyebrow: "Waiting for first publish",
      title: "No snapshot has been published yet.",
      body:
        "The control plane is reachable and the store is empty. The factory " +
        "machine has not published a projection yet.",
      mirror: "none published",
      publisher: "not connected",
    });
    return;
  }

  if (!response.ok) {
    renderState({
      eyebrow: "Store unreachable",
      title: "The snapshot store did not answer.",
      body: `The store responded with ${response.status}. This view is a mirror; the factory is unaffected.`,
      mirror: `error ${response.status}`,
      publisher: "unknown",
      stale: true,
    });
    return;
  }

  let snapshot;
  try {
    snapshot = await response.json();
  } catch {
    renderState({
      eyebrow: "Store unreachable",
      title: "The snapshot store returned something unreadable.",
      body: "Treat this view as stale until the next publish succeeds.",
      mirror: "unreadable",
      publisher: "unknown",
      stale: true,
    });
    return;
  }

  // A snapshot exists but nothing renders it until node #189.
  renderState({
    eyebrow: "Snapshot received",
    title: "A projection is published, and this view cannot render it yet.",
    body:
      "The mirror renderer arrives with campaign node #189. Until then the " +
      "snapshot is stored and reachable but not displayed.",
    mirror: snapshot?.publishedAt ? age(snapshot.publishedAt) : "published",
    publisher: snapshot?.publisher ? String(snapshot.publisher) : "unnamed",
  });
}

els.signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.signinSubmit.disabled = true;
  els.signinError.hidden = true;
  try {
    const response = await request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: els.password.value }),
    });
    if (response.ok) {
      els.password.value = "";
      await loadMirror();
      return;
    }
    showSignIn(
      response.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : "That password was not accepted.",
    );
  } catch {
    showSignIn("Could not reach the control plane.");
  } finally {
    els.signinSubmit.disabled = false;
  }
});

els.signOut.addEventListener("click", async () => {
  try {
    await request("/api/session", { method: "DELETE" });
  } catch {
    // Clearing the cookie server-side is best effort; the view resets either
    // way, and an expired or orphaned cookie grants nothing on its own.
  }
  showSignIn();
});

async function main() {
  try {
    const response = await request("/api/session");
    const { authenticated } = await response.json();
    if (authenticated) {
      await loadMirror();
      return;
    }
  } catch {
    // Fall through to the sign-in view: unknown is never treated as allowed.
  }
  showSignIn();
}

main();
