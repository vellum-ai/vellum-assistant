/**
 * Public entry point for the `@vellumai/assistant-api` package.
 *
 * Consumers (web client, gateway, evals, etc.) import from
 * `"@vellumai/assistant-api"`; this file is what their import lands on,
 * resolved via tsconfig path mapping + Vite alias rather than via a
 * `file:` workspace dependency.
 *
 * The package boundary is enforced by **import discipline**, not by
 * filesystem isolation:
 *
 * - Nothing under this directory imports from `assistant/src/daemon/`,
 *   `assistant/src/runtime/`, `assistant/src/agent-loop/`, or any other
 *   daemon-runtime module.
 * - Nothing here uses Node/Bun-specific APIs (fs, net, etc.) — must stay
 *   browser-safe so the web bundle is happy.
 * - Allowed runtime deps are vendored explicitly in `package.json`. Today
 *   that's `zod` only.
 *
 * See `./README.md` for the full charter.
 *
 * ## Surface today
 *
 * - SSE event wire schemas: see {@link "./sse-events/index.js"}
 *
 * ## What lives here next (planned)
 *
 * - Per-event SSE wire schemas to replace the hand-rolled parser in
 *   `apps/web/src/domains/chat/api/event-parser.ts` (~900 lines of
 *   `typeof data.x === "string" ? data.x : ""` boilerplate).
 * - HTTP request/response schemas for the daemon's public endpoints.
 * - Pure helper functions for constructing/parsing wire-shaped data.
 */

export * from "./sse-events/index.js";
