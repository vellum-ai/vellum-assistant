import type { Ref, RefCallback } from "react";

/**
 * One callback ref that hands the element to every ref in `refs`, for a
 * component that needs its element itself and also forwards a caller's ref.
 *
 * It speaks React 19's cleanup protocol: it returns a cleanup, so React calls
 * that on detach instead of calling it again with `null`, and the cleanup
 * detaches each ref the way that ref expects. A callback ref that returned its
 * own cleanup gets that cleanup run, one that returned nothing is called with
 * `null`, and an object ref is emptied. Dropping a returned cleanup would leave
 * a callback ref that tears down only there never torn down.
 *
 * Memoize the result on its refs: a new callback each render makes React
 * detach and reattach every ref on every render.
 *
 * @see https://react.dev/reference/react-dom/components/common#ref-callback
 */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (node) => {
    const detach = refs.map((ref) => {
      if (typeof ref === "function") {
        const cleanup = ref(node);
        return typeof cleanup === "function" ? cleanup : () => ref(null);
      }
      if (ref) {
        ref.current = node;
        return () => {
          ref.current = null;
        };
      }
      return undefined;
    });
    // Every ref is detached even if one throws, since React sees one cleanup
    // and cannot run the rest itself; the first error is rethrown after.
    return () => {
      const errors: unknown[] = [];
      for (const cleanup of detach) {
        try {
          cleanup?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw errors[0];
      }
    };
  };
}
