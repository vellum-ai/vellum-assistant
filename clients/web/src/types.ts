/**
 * Shared types for the Vellum web client.
 *
 * Lives in its own file so both the server (`server.ts`) and the browser
 * bundle (`bundle.tsx`) can reference it without a circular import.
 */

export interface ClientConfig {
  /** Base URL the React app should use for backend requests. */
  apiBase: string;
}

export type Unmount = () => void;

/** Shape of the ESM bundle's default export contract. */
export interface MountFn {
  (el: HTMLElement, config: ClientConfig): Unmount;
}
