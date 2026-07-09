/**
 * Browser page translation (Chrome / Safari / Google Translate) rewrites text
 * nodes by wrapping them in `<font>` elements after React has committed the
 * DOM. React keeps references to the original text nodes, so a later
 * reconciliation can call `removeChild` / `insertBefore` against a node the
 * translator has re-parented, throwing
 * `DOMException: Failed to execute 'removeChild' on 'Node'` and unmounting the
 * whole app.
 *
 * These guards make the two reconciler-facing `Node` methods tolerant of that
 * mismatch. The translator either wraps a node in place (`this → <font> → text`)
 * or moves it under a wrapper elsewhere in the tree. In both cases the node
 * React holds is no longer a direct child of `this`:
 *
 * - `removeChild`: if the node is now nested under a wrapper that is itself a
 *   child of `this`, remove that wrapper (so the content React wants gone
 *   actually disappears); otherwise no-op.
 * - `insertBefore`: insert before the wrapper that stands in for the stale
 *   reference (preserving order); fall back to appending if no such wrapper is
 *   under `this`.
 *
 * Every other caller behaves normally; a genuine parentage bug in our own code
 * still recovers but is surfaced via `console.warn`, which session recording
 * captures. The guard is installed once, before React first commits, and is
 * idempotent.
 *
 * Reference: https://github.com/facebook/react/issues/11538
 */

let installed = false;

/**
 * Walk up from `node` to the ancestor that is a direct child of `parent`
 * (i.e. the translator wrapper standing in for `node`). Returns `null` when
 * `node` is not inside `parent` at all.
 */
function childOfParent(node: Node, parent: Node): Node | null {
  let current: Node | null = node;
  while (current && current.parentNode !== parent) {
    current = current.parentNode;
  }
  return current;
}

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
    if (child.parentNode === this) {
      return originalRemoveChild.call(this, child) as T;
    }
    const wrapper = childOfParent(child, this);
    if (wrapper) {
      console.warn(
        "[translate-dom-guard] removeChild target was wrapped by page translation; removing the wrapper instead",
        child,
      );
      originalRemoveChild.call(this, wrapper);
      return child;
    }
    console.warn(
      "[translate-dom-guard] Skipped removeChild for a node re-parented by page translation",
      child,
    );
    return child;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function guardedInsertBefore<T extends Node>(
    this: Node,
    node: T,
    reference: Node | null,
  ): T {
    if (!reference || reference.parentNode === this) {
      return originalInsertBefore.call(this, node, reference) as T;
    }
    const anchor = childOfParent(reference, this);
    console.warn(
      "[translate-dom-guard] insertBefore reference was re-parented by page translation; inserting before its wrapper",
      reference,
    );
    return originalInsertBefore.call(this, node, anchor) as T;
  };
}
