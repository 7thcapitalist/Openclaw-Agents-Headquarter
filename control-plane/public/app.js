// The control plane's empty state, and the seam the renderer fills.
//
// Campaign HQ_CONTROL_PLANE_2026 node 1. There is no store yet (node #187) and
// no renderer yet (node #189), so the only honest thing this page can do is ask
// whether a snapshot exists and say plainly what came back.
//
// It asks rather than hardcoding "nothing published", because a page that
// asserts a state it never checked is how the 404 that started this campaign
// went unnoticed: the deployment reported success while serving nothing.

const MIRROR_URL = "/api/mirror";

// Long enough that a slow cold start is not reported as an outage, short enough
// that the page never sits blank.
const TIMEOUT_MS = 8000;

const els = {
  state: document.getElementById("state"),
  eyebrow: document.getElementById("state-eyebrow"),
  title: document.getElementById("state-title"),
  body: document.getElementById("state-body"),
  mirror: document.getElementById("fact-mirror"),
  publisher: document.getElementById("fact-publisher"),
};

function render({ eyebrow, title, body, mirror, publisher, stale = false }) {
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

async function fetchSnapshot() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    return await fetch(MIRROR_URL, { signal: abort.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let response;
  try {
    response = await fetchSnapshot();
  } catch {
    // Offline, aborted, or the endpoint does not exist yet. Until node #187
    // lands there is nothing to reach, and that is the expected state — not a
    // failure worth alarming about.
    render({
      eyebrow: "Waiting for first publish",
      title: "No snapshot has been published yet.",
      body:
        "This is the control plane for OpenClaw Headquarters. It renders a " +
        "projection that the factory machine publishes outbound. Nothing has " +
        "arrived yet, so there is nothing to show — this page is not broken, " +
        "and it is not hiding an error.",
      mirror: "none published",
      publisher: "not connected",
    });
    return;
  }

  if (response.status === 404) {
    render({
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
    render({
      eyebrow: "Store unreachable",
      title: "The snapshot store did not answer.",
      body:
        `The store responded with ${response.status}. Headquarters itself is ` +
        "unaffected — it runs on the factory machine and this view is a mirror.",
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
    render({
      eyebrow: "Store unreachable",
      title: "The snapshot store returned something unreadable.",
      body:
        "The response was not JSON. Treat this view as stale until the next " +
        "publish succeeds.",
      mirror: "unreadable",
      publisher: "unknown",
      stale: true,
    });
    return;
  }

  // A snapshot exists but nothing renders it until node #189. Saying so beats
  // rendering a blank page that looks like the empty state above.
  render({
    eyebrow: "Snapshot received",
    title: "A projection is published, and this view cannot render it yet.",
    body:
      "The mirror renderer arrives with campaign node #189. Until then the " +
      "snapshot is stored and reachable but not displayed.",
    mirror: snapshot?.publishedAt ? age(snapshot.publishedAt) : "published",
    publisher: snapshot?.publisher ? String(snapshot.publisher) : "unnamed",
  });
}

main();
