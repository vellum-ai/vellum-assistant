import { Link } from "react-router";
import { type ComponentProps, type ReactNode } from "react";

/**
 * Framework-agnostic Link adapter.
 *
 * Wraps React Router v7's `<Link>` component. Consumers use `href`
 * prop (matching HTML semantics); this maps to RR's `to` prop.
 */
export function AppLink({
  href,
  children,
  ref,
  ...rest
}: {
  href: string;
  children?: ReactNode;
  ref?: React.Ref<HTMLAnchorElement>;
} & Omit<ComponentProps<typeof Link>, "to" | "children">) {
  return (
    <Link ref={ref} to={href} {...rest}>
      {children}
    </Link>
  );
}

/**
 * Route string type alias. Plain string in React Router v7.
 */
export type AppRoute = string;
