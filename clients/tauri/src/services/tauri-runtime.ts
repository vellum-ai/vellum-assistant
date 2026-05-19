export function isTauriRuntime(): boolean {
  return typeof getTauriInternals() !== "undefined";
}

function getTauriInternals(): unknown {
  return (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}
