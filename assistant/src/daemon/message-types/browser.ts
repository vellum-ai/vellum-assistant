// Browser interaction types.
// CDP request/response IPC was removed — Playwright's connectOverCDP is broken
// under Bun's runtime. Browser is now launched directly via Playwright.

// --- Domain-level union aliases (consumed by the barrel file) ---
// These must exist (even as `never`) so the barrel union compiles.

export type _BrowserClientMessages = never;

export type _BrowserServerMessages = never;
