// Next.js vendors path-to-regexp under this path without shipping type
// declarations. next-config.test.ts drives rewrite `source`/`destination`
// strings through the same matcher Next uses at runtime, so declare the two
// helpers it consumes. Ambient module declaration: this file intentionally
// has no top-level import/export so it types the untyped module rather than
// augmenting it.
declare module "next/dist/compiled/path-to-regexp" {
  export function match(
    path: string,
    options?: { delimiter?: string; sensitive?: boolean; strict?: boolean }
  ): (
    pathname: string
  ) => false | { params: Record<string, string | string[]> };
  export function compile(
    path: string,
    options?: { validate?: boolean }
  ): (params: Record<string, string | string[]>) => string;
}
