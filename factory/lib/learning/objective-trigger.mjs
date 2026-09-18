import { Worker } from "node:worker_threads";

export async function triggerObjectiveLearningRun({ hqRoot, now = new Date().toISOString() } = {}) {
  if (!hqRoot) return { ok: false, skipped: true, error: "hqRoot is required" };
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./objective-trigger-worker.mjs", import.meta.url), {
      workerData: { hqRoot, now },
    });
    // The objective path never awaits this promise. Do not keep the dashboard
    // process alive solely for best-effort learning work during shutdown.
    worker.unref();
    worker.once("message", resolve);
    worker.once("error", (error) => resolve({ ok: false, error: String(error?.message || error) }));
    worker.once("exit", (code) => {
      if (code !== 0) resolve({ ok: false, error: `learning worker exited with code ${code}` });
    });
  });
}
