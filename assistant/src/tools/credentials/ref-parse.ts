/**
 * Credential reference parsing. Pure string work, no store access.
 *
 * `"service/field"` is the shared vocabulary of every credential entry point:
 * the CLI, the reveal and set routes, and the plugin-facing read and write
 * APIs all name credentials this way. The rules for what counts as a valid
 * reference live here so each path applies the same ones.
 *
 * Deliberately separate from {@link ./resolve}, which reads the metadata store:
 * a caller that only needs to split a reference should not import a module
 * whose behavior depends on what is stored.
 */

/**
 * Parse a `"service/field"` credential reference into its parts.
 *
 * Returns undefined for anything that is not exactly one non-empty segment on
 * each side of a single slash: no slash, a leading or trailing slash, or more
 * than one slash as in `"fal/api/key"`.
 */
export function parseServiceFieldRef(
  ref: string,
): { service: string; field: string } | undefined {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= ref.length - 1) {
    return undefined;
  }
  if (ref.indexOf("/", slashIndex + 1) !== -1) {
    return undefined;
  }
  return {
    service: ref.slice(0, slashIndex),
    field: ref.slice(slashIndex + 1),
  };
}
