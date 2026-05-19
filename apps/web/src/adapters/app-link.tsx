// TODO: port from platform
import { Link } from "react-router";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

export const AppLink = forwardRef<
  HTMLAnchorElement,
  { href: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">
>(function AppLink({ href, children, ...rest }, ref) {
  return <Link ref={ref} to={href} {...rest}>{children}</Link>;
});

export type AppRoute = string;
