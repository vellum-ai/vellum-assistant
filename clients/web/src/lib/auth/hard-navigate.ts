/**
 * Navigate by replacing the current page, destroying the JS context.
 *
 * Logout MUST use this instead of React Router's `navigate()`.
 * `navigate()` is an SPA transition — it swaps route components but
 * preserves the entire JavaScript execution context: every Zustand
 * module-level singleton, every closure, every module variable.
 * `window.location.replace()` triggers a full page load, which is
 * the only browser primitive that guarantees complete state destruction.
 * Using `replace` instead of assigning `location.href` removes the
 * pre-logout page from session history so the user cannot navigate
 * back into it, and prevents bfcache from restoring stale state.
 *
 * This is the standard pattern used by GitHub, Slack, and other
 * production SPAs for logout. React Router intentionally does not
 * provide a "destroy everything" helper because SPA routers are
 * designed to preserve state across navigations — for logout,
 * preservation is the problem.
 *
 * References:
 * - https://web.dev/articles/sign-out-best-practices
 * - https://web.dev/articles/bfcache (hard nav prevents bfcache restoration)
 */
export function hardNavigate(url: string): void {
  window.location.replace(url);
}
