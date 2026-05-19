import { redirect } from "react-router";

/**
 * Framework-agnostic redirect adapters.
 *
 * Wraps React Router v7's redirect for use in loaders/actions.
 */
export function appRedirect(url: string): never {
  throw redirect(url);
}

export function appPermanentRedirect(url: string): never {
  throw redirect(url, 301);
}
