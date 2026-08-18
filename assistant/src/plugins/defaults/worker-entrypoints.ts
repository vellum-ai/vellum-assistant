export async function loadDefaultMemoryWorker(): Promise<void> {
  await import("./memory/worker.js");
}
