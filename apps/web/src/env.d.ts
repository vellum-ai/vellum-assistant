/// <reference types="vite/client" />

/**
 * Build-time environment variables exposed to the client bundle.
 *
 * All `VITE_*` vars are public and embedded in the JS bundle at build time.
 * Server-only values (API keys, auth tokens) use unprefixed names and are
 * NOT available here — they remain in `process.env` during CI/CD only.
 *
 * Reference: https://vite.dev/guide/env-and-mode#intellisense-for-typescript
 */
interface ImportMetaEnv {
  /** Sentry DSN for browser error reporting. Injected by CI/CD pipeline. */
  readonly VITE_SENTRY_DSN?: string;
  /** Sentry environment tag (e.g. "production", "staging"). */
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  /** Stripe publishable key for payment forms. Injected by CI/CD pipeline. */
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  /** App version stamp for diagnostic reporting. */
  readonly VITE_APP_VERSION?: string;
  /** Enable local-mode: read assistant lockfile from the CLI daemon. */
  readonly VITE_LOCAL_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
