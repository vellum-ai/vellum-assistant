/**
 * Exposes the full `@vellumai/assistant-api` namespace on
 * `window._vellumDebug.api` for browser-console introspection.
 *
 * Confirms that the canonical wire-contract package is reachable in the
 * shipped bundle: open DevTools and inspect
 * `window._vellumDebug.api.RelationshipStateUpdatedSchema` (or any other
 * exported schema) to verify the source-as-package wiring is intact.
 *
 * Import this module for side effects from `main.tsx` so the binding is
 * established at app bootstrap, independent of any page mount lifecycle.
 */
import * as api from "@vellumai/assistant-api";

if (typeof window !== "undefined") {
  const root = (window._vellumDebug ??= {});
  root.api = api;
}
