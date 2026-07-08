/**
 * Browser page translation (Chrome / Safari / Google Translate) rewrites text
 * nodes by wrapping them in `<font>` elements after React has committed the
 * DOM. React keeps references to the original text nodes, so a later
 * reconciliation can call `removeChild` / `insertBefore` against a node the
 * translator has already re-parented, throwing
 * `DOMException: Failed to execute 'removeChild' on 'Node'` and unmounting the
 * whole app.
 *
 * These guards make the two reconciler-facing `Node` methods tolerant of that
 * one mismatch: when the node the caller expects to operate on no longer lives
 * under `this`, the call recovers (no-op for remove, append for insert) instead
 * of throwing, so the app keeps running while the translator re-translates the
 * subtree. Every other caller behaves normally; a genuine parentage bug in our
 * own code still recovers but is surfaced via `console.warn`, which session
 * recording captures.
 *
 * The guard is installed once, before React first commits. It is idempotent.
 *
 * Reference: https://github.com/facebook/react/issues/11538
 */

let installed = false;

export function installTranslateDomGuard(): void {
  if (installed) {
    return;
  }
  if (typeof Node !== "function" || !Node.prototype) {
    return;
  }
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function guardedRemoveChild<T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      console.warn(
        "[translate-dom-guard] Skipped removeChild for a node re-parented by page translation",
        child,
      );
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function guardedInsertBefore<T extends Node>(
    this: Node,
    node: T,
    reference: Node | null,
  ): T {
    if (reference && reference.parentNode !== this) {
      console.warn(
        "[translate-dom-guard] Reference node re-parented by page translation; appending instead of insertBefore",
        reference,
      );
      return originalInsertBefore.call(this, node, null) as T;
    }
    return originalInsertBefore.call(this, node, reference) as T;
  };
}
