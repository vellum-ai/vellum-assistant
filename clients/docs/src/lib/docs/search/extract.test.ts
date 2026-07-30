import { describe, expect, test } from "bun:test";

import { extractDocsPageFromHtml } from "@/lib/docs/search/extract";

describe("extractDocsPageFromHtml", () => {
  test("extracts route metadata and section chunks", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Getting Started</div>
        <h1>Getting Started</h1>
        <div class="docs-prose">
          <section id="install">
            <h2 id="install">Installation</h2>
            <p>Run the installer and open the app.</p>
          </section>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/getting-started", html);

    expect(extracted.pageTitle).toBe("Getting Started");
    expect(extracted.breadcrumb).toBe("Docs / Getting Started");
    expect(extracted.chunks.length).toBeGreaterThanOrEqual(2);

    const sectionChunk = extracted.chunks.find((chunk) => chunk.sectionId === "install");
    expect(sectionChunk?.url).toBe("/docs/getting-started#install");
    expect(sectionChunk?.heading).toBe("Installation");
    expect(sectionChunk?.body).toContain("Run the installer");
  });

  test("extracts multiple heading levels from sections", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Help</div>
        <h1>FAQ</h1>
        <div class="docs-prose">
          <section id="top">
            <h2 id="top">Top Questions</h2>
            <p>Top answers.</p>
          </section>
          <section id="billing">
            <h3 id="billing">Billing</h3>
            <p>Billing answers.</p>
          </section>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/help/faq", html);

    const h2Chunk = extracted.chunks.find((chunk) => chunk.sectionId === "top");
    const h3Chunk = extracted.chunks.find((chunk) => chunk.sectionId === "billing");

    expect(h2Chunk?.headingLevel).toBe(2);
    expect(h3Chunk?.headingLevel).toBe(3);
  });

  test("chunks standalone headings even when sections exist", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Guides</div>
        <h1>Guides</h1>
        <div class="docs-prose">
          <section id="setup">
            <h2 id="setup">Setup</h2>
            <p>Setup instructions here.</p>
          </section>
          <h2 id="troubleshooting">Troubleshooting</h2>
          <p>Troubleshooting tips here.</p>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/guides", html);

    const sectionChunk = extracted.chunks.find((chunk) => chunk.sectionId === "setup");
    const standaloneChunk = extracted.chunks.find((chunk) => chunk.sectionId === "troubleshooting");

    expect(sectionChunk?.url).toBe("/docs/guides#setup");
    expect(standaloneChunk?.url).toBe("/docs/guides#troubleshooting");
    expect(standaloneChunk?.heading).toBe("Troubleshooting");

    const setupChunks = extracted.chunks.filter((chunk) => chunk.sectionId === "setup");
    expect(setupChunks.length).toBe(1);
  });

  test("creates fallback page chunk when headings are missing", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Intro</div>
        <h1>Welcome</h1>
        <div class="docs-prose">
          <p>Hello docs world.</p>
          <p>This page has no section headings.</p>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs", html);

    expect(extracted.chunks.length).toBeGreaterThan(0);
    const pageChunk = extracted.chunks.find((chunk) => chunk.sectionId === null);
    expect(pageChunk).toBeDefined();
    expect(pageChunk?.url).toBe("/docs");
    expect(pageChunk?.body).toContain("Hello docs world");
  });
});
