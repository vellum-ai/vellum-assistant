/** Ambient type augmentation for `import.meta.env` in Vite-based consumers. */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * A side-effect stylesheet import type-checks without a declaration, but the
 * dynamic `import()` in `markdown-message.tsx` (lazy KaTeX) needs a module
 * type. Declared for the one stylesheet imported that way, not `*.css`, so a
 * typo in any other specifier still fails resolution.
 */
declare module "katex/dist/katex.min.css";
