/**
 * Type declaration for the bundled `@vellumai/plugin-api` artifact.
 *
 * The runtime file `index.js` is consumed via `import path from
 * "../plugin-api/bundle/index.js" with { type: "file" }` in
 * `src/embedded/plugin-api.ts`, which makes Bun return the file's
 * runtime PATH (a string) rather than its module exports. Hence the
 * default export is typed as `string`.
 *
 * This declaration is hand-maintained — the build script does not
 * regenerate it. When PR-5 wires up npm publish, this file becomes a
 * real generated declaration covering the public plugin-api surface.
 */
declare const pluginApiPath: string;
export default pluginApiPath;
