/**
 * Inline a Vellum sandbox app's compiled dist bundle into a single
 * self-contained HTML string.
 *
 * Vellum's multi-file apps compile to `dist/index.html` plus sibling
 * `main.js` / `main.css` referenced by relative tags. To drive such an
 * app in an offline browser (no asset server), those references must be
 * folded into the document so it renders from `page.setContent(html)`
 * alone.
 *
 * The daemon performs the equivalent inlining when it delivers an app
 * over SSE (`assistant/src/memory/app-store.ts` `inlineDistAssets`). The
 * regexes and `</script>` escaping are replicated here verbatim rather
 * than imported because the evals harness must not depend on `assistant/`
 * (see the cross-package import boundary in `AGENTS.md`).
 */

/** A Vellum app's compiled dist files, read out of the container. */
export interface AppDistFiles {
  /** Contents of `dist/index.html` (required). */
  indexHtml: string;
  /** Contents of `dist/main.js`, when present. */
  mainJs?: string;
  /** Contents of `dist/main.css`, when present. */
  mainCss?: string;
}

/**
 * Fold `main.js` and `main.css` into the compiled `index.html`, yielding
 * a self-contained document. Files left `undefined` keep their original
 * `<script>` / `<link>` tag untouched, mirroring the daemon's behaviour
 * when an asset is absent.
 */
export function inlineAppDist(files: AppDistFiles): string {
  let html = files.indexHtml;

  if (files.mainJs !== undefined) {
    const js = files.mainJs.replace(/<\/script>/g, "<\\/script>");
    html = html.replace(
      /<script\s+type="module"\s+src="main\.js"\s*><\/script>/,
      () => `<script type="module">${js}</script>`,
    );
  }

  if (files.mainCss !== undefined) {
    const css = files.mainCss;
    html = html.replace(
      /<link\s+rel="stylesheet"\s+href="main\.css"\s*>/,
      () => `<style>${css}</style>`,
    );
  }

  return html;
}
