/**
 * Whether a plugin may read or write a credential named `service/field`.
 *
 * Two conventions are in use, and a plugin is in scope if either matches:
 *
 * - Field-owned: `openai/acme` belongs to plugin `acme`. This is the shape
 *   documented on the plugin API: the plugin's manifest name is the field,
 *   and the service is whoever issued the secret.
 * - Service-owned: `imessage/api_key` belongs to plugin `imessage`. A plugin
 *   that stores several secrets namespaces the service as itself and uses
 *   field names for the individual values.
 *
 * A credential that matches neither (`openai/api_key` from plugin
 * `imessage`) stays out of reach. The check is name equality only; it does
 * not look the credential up.
 */
export function credentialInPluginScope(
  pluginName: string,
  service: string,
  field: string,
): boolean {
  return field === pluginName || service === pluginName;
}
