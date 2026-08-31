/**
 * @vellumai/avatar-catalog: the single definition of the components an
 * assistant's character avatar is composed from.
 *
 * The daemon serves this catalog over `/avatar/character-components` and
 * renders PNGs from it; clients bundle it because an avatar has to compose
 * before the daemon can answer (the hatching screen, the assistant chooser,
 * a transcript's subagent chips). Bundling is why this is a package rather
 * than a daemon module every client copies.
 *
 * The palette is deliberately not re-exported here. It lives behind
 * `@vellumai/avatar-catalog/colors`, and importing it from that subpath is
 * what keeps boot-path code (a sidebar pin resolving a stored colour id, the
 * accent variable's fallback) off the ~47 kB of SVG path data the shapes
 * carry. Re-exporting it would make the expensive import the convenient one.
 *
 * The shapes' types stay internal for the same reason they were private to
 * the daemon module this package replaces: the wire contract for this data is
 * the route's `responseBody` schema, which clients consume through their
 * generated OpenAPI types. A hand-written type exported from here would be a
 * second name for that shape, and the closer one to reach for.
 *
 * Leaf package: no dependencies, no runtime imports.
 */
export { getCharacterComponents } from "./catalog.js";
