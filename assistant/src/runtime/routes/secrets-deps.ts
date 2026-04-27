/**
 * Module-level singleton for secrets route dependencies.
 *
 * The daemon server registers its CES client accessor and provider-reload
 * callback at startup via {@link registerSecretsDeps}. Route handlers import
 * {@link getSecretsDeps} to access them without DI.
 */

import type { CesClient } from "../../credential-execution/client.js";

export interface SecretsDeps {
  getCesClient: () => CesClient | undefined;
  onProviderCredentialsChanged: () => void | Promise<void>;
}

let _deps: SecretsDeps | undefined;

export function registerSecretsDeps(deps: SecretsDeps): void {
  _deps = deps;
}

export function getSecretsDeps(): SecretsDeps | undefined {
  return _deps;
}
