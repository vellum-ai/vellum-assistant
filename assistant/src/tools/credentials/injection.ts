/**
 * Shared credential value injection helpers used by the script-proxy MITM
 * path and by plugin-api `authedFetch`.
 */

import { getSecureKeyAsync } from "../../security/secure-keys.js";
import type { CredentialInjectionTemplate } from "./policy-types.js";
import { resolveByServiceField } from "./resolve.js";

/**
 * Build the final header (or query) value for a matched credential injection
 * template. Handles optional composition with a second credential and value
 * transforms. Returns null if any referenced credential cannot be resolved.
 */
export async function buildInjectedValue(
  tpl: CredentialInjectionTemplate,
  primaryValue: string,
): Promise<string | null> {
  let value = primaryValue;

  if (tpl.composeWith) {
    const composed = resolveByServiceField(
      tpl.composeWith.service,
      tpl.composeWith.field,
    );
    if (!composed) {
      return null;
    }
    const composedValue = await getSecureKeyAsync(composed.storageKey);
    if (!composedValue) {
      return null;
    }
    value = `${value}${tpl.composeWith.separator}${composedValue}`;
  }

  if (tpl.valueTransform === "base64") {
    value = Buffer.from(value).toString("base64");
  }

  return (tpl.valuePrefix ?? "") + value;
}
