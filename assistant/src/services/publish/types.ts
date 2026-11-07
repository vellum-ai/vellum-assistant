/**
 * The contract every app publish target implements.
 *
 * An app is published by compiling it to a single self-contained HTML
 * document and handing that document to a provider, which returns the public
 * URL the app is served from plus an opaque deployment id the next deploy and
 * the unpublish are keyed on.
 */

import type { PublishProviderId } from "../../config/schemas/apps.js";

export type { PublishProviderId };

/** What a provider is told about the app it is deploying. */
export interface AppPublishMeta {
  appId: string;
  /** The app's display name. */
  name: string;
  /** Lowercase, hyphenated form of the name; usable as a hostname label. */
  slug: string;
  /** Deployment id returned by a previous deploy of this app, when it has one. */
  previousDeploymentId?: string;
}

export interface PublishResult {
  url: string;
  deploymentId: string;
}

/**
 * The credential a provider authenticates with. `required: false` means the
 * provider deploys unauthenticated when the credential is absent, which is
 * how a webhook pointed at a shim on the user's own network works.
 */
export interface PublishCredentialSpec {
  service: string;
  field: string;
  required: boolean;
  /** Shown to the user when the credential is required but absent. */
  missingMessage: string;
}

export interface PublishProvider {
  id: PublishProviderId;
  /** Shown to users wherever the publish target is named. */
  displayName: string;
  credential: PublishCredentialSpec;
  deploy(
    html: string,
    meta: AppPublishMeta,
    token: string | null,
  ): Promise<PublishResult>;
  /**
   * Take a live deployment down at the provider. Optional: a provider that
   * cannot (or need not) revoke a deployment omits it, and the local record is
   * still marked inactive.
   */
  unpublish?(meta: AppPublishMeta, token: string | null): Promise<void>;
}

/** Lowercase, hyphen-separated form of an app name, safe as a hostname label. */
export function appSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
