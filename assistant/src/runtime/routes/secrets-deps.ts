/**
 * Module-level singleton for secrets route dependencies.
 *
 * The daemon registers its provider-reload callback at startup via
 * {@link registerSecretsDeps}. Route handlers import {@link getSecretsDeps} to
 * access it without DI.
 */

export interface SecretsDeps {
  onProviderCredentialsChanged: () => void | Promise<void>;
}

let _deps: SecretsDeps | undefined;

export function registerSecretsDeps(deps: SecretsDeps): void {
  _deps = deps;
}

export function getSecretsDeps(): SecretsDeps | undefined {
  return _deps;
}
