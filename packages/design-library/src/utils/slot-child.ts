import { Fragment, isValidElement, type ReactNode } from "react";

/**
 * Reports an `asChild` child that Radix `Slot` cannot merge onto.
 *
 * `Slot` clones the child with the parent's props and composes the two refs,
 * and it skips both for a fragment: the clone guards ref composition with
 * `children.type !== Fragment`, and a fragment ignores every prop but `key`, so
 * the styling and aria attributes the parent supplies are dropped as well. The
 * row then renders with none of its geometry and holds no ref, silently.
 *
 * A type cannot state this. A fragment and an element are both `ReactElement`:
 * `<></>` is typed as `JSX.Element` with nothing to exclude on, so the boundary
 * is checkable only at runtime. Development builds log; nothing is thrown,
 * since a dropped class is a visual bug rather than a reason to take the tree
 * down.
 *
 * @see https://www.radix-ui.com/primitives/docs/utilities/slot
 * @see https://react.dev/reference/react/Fragment
 */
export function reportUnmergeableSlotChild(
  componentName: string,
  child: ReactNode,
): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  if (!isValidElement(child) || child.type !== Fragment) {
    return;
  }
  // eslint-disable-next-line no-console
  console.error(
    `${componentName}: an \`asChild\` child must be a single element that ` +
      `renders a DOM node. A fragment takes neither the merged props nor the ` +
      `ref, so the row renders unstyled. Move the fragment's contents into ` +
      `the element that should carry the row, or drop \`asChild\`.`,
  );
}
