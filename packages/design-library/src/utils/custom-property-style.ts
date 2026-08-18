import type { CSSProperties } from "react";

/**
 * A `style` object that also declares CSS custom properties.
 *
 * React writes any `--*` key straight through to the element, and that is how
 * a caller tints a component whose styling reads custom properties. React's
 * `CSSProperties` is csstype's list of standard properties with no index
 * signature, though, so an object literal carrying a `--*` key is not
 * assignable to it and the usual workaround is to assert the whole object,
 * which drops the checking on every standard property in it too.
 *
 * Naming the shape instead keeps the standard properties checked, keeps the
 * custom ones readable at their declaration and at the point they are read,
 * and stays assignable to `style`.
 *
 * @see https://react.dev/reference/react-dom/components/common#applying-css-styles
 * @see https://github.com/frenic/csstype#what-should-i-do-when-i-get-type-errors
 */
export type CustomPropertyStyle = CSSProperties &
  Record<`--${string}`, string | number>;
