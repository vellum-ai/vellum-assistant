/**
 * The avatar colour palette, for boot-path code that needs only the hex
 * values: a sidebar pin resolving a stored colour id on first render, and the
 * accent CSS variable's fallback before the daemon's catalog arrives.
 *
 * Imported from `@vellumai/avatar-catalog/colors` rather than the package
 * root so the ~47 kB of SVG path data behind the shapes stays off that path.
 */
export { AVATAR_COLORS as BUNDLED_COLORS } from "@vellumai/avatar-catalog/colors";
