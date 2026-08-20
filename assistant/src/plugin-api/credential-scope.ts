/**
 * Whether a plugin may read or write a credential named `service/field`.
 *
 * The plugin's manifest name is the service it owns. Plugin `imessage` may
 * resolve `imessage/api_key` and `imessage/photon_project_id`, and nothing
 * under another service (`openai/api_key`, `openai/imessage`). The check is
 * name equality only; it does not look the credential up.
 */
export function credentialInPluginScope(
  pluginName: string,
  service: string,
): boolean {
  return service === pluginName;
}
