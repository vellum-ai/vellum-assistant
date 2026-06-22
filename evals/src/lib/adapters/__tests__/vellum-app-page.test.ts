import { describe, expect, test } from "bun:test";

import { inlineAppDist } from "../vellum-app-page";

// `inlineAppDist` replicates the daemon's `inlineDistAssets`
// (`assistant/src/memory/app-store.ts`): it folds the sibling `main.js`
// and `main.css` a compiled app references into `index.html` so the
// page renders from `page.setContent(html)` alone, with no asset
// server. These tests pin that contract — including the `</script>`
// escaping that keeps an embedded close tag from breaking out of the
// inlined module script.

const INDEX_HTML = [
  "<!doctype html>",
  '<html><head><link rel="stylesheet" href="main.css"></head>',
  '<body><div id="root"></div>',
  '<script type="module" src="main.js"></script></body></html>',
].join("\n");

describe("inlineAppDist", () => {
  test("folds main.js and main.css into index.html as inline tags", () => {
    // GIVEN a compiled index.html that references sibling main.js + main.css
    // WHEN both assets are supplied
    const html = inlineAppDist({
      indexHtml: INDEX_HTML,
      mainJs: 'console.log("ready");',
      mainCss: "body { color: red; }",
    });

    // THEN the external references are replaced with inline tags carrying
    // the asset contents, and the original src/href tags are gone.
    expect(html).toContain(
      '<script type="module">console.log("ready");</script>',
    );
    expect(html).toContain("<style>body { color: red; }</style>");
    expect(html).not.toContain('src="main.js"');
    expect(html).not.toContain('href="main.css"');
  });

  test("escapes embedded </script> in main.js so it can't break out of the inline script", () => {
    // GIVEN JS whose string literal contains a literal </script> close tag
    // WHEN it is inlined
    const html = inlineAppDist({
      indexHtml: INDEX_HTML,
      mainJs: 'const s = "</script>";',
    });

    // THEN the close tag is escaped to <\/script> inside the inline script,
    // leaving only the genuine closing tag of the injected <script> element.
    expect(html).toContain(
      '<script type="module">const s = "<\\/script>";</script>',
    );
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  test("leaves the original tags untouched when an asset is absent", () => {
    // GIVEN neither optional asset is supplied (a bare static app)
    // WHEN inlining runs
    const html = inlineAppDist({ indexHtml: INDEX_HTML });

    // THEN index.html is returned verbatim, keeping its external references.
    expect(html).toBe(INDEX_HTML);
  });

  test("inlines only the supplied asset and leaves the other reference intact", () => {
    // GIVEN only main.css is supplied, with main.js missing
    // WHEN inlining runs
    const html = inlineAppDist({
      indexHtml: INDEX_HTML,
      mainCss: "body { margin: 0; }",
    });

    // THEN the stylesheet is inlined while the script src tag is preserved.
    expect(html).toContain("<style>body { margin: 0; }</style>");
    expect(html).toContain('<script type="module" src="main.js"></script>');
  });

  test("inlines an empty asset as an empty inline tag", () => {
    // GIVEN an asset that exists on disk but is empty (distinct from absent)
    // WHEN inlining runs
    const html = inlineAppDist({
      indexHtml: INDEX_HTML,
      mainJs: "",
      mainCss: "",
    });

    // THEN the external references collapse to empty inline tags rather than
    // being left untouched — an empty file is still a present file.
    expect(html).toContain('<script type="module"></script>');
    expect(html).toContain("<style></style>");
    expect(html).not.toContain('src="main.js"');
    expect(html).not.toContain('href="main.css"');
  });
});
