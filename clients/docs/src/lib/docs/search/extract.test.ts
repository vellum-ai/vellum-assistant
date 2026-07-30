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

  test("scopes standalone heading chunks to their own heading block", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Guides</div>
        <h1>Guides</h1>
        <div class="docs-prose">
          <h2 id="install">Install</h2>
          <p>Download the installer bundle.</p>
          <h2 id="uninstall">Uninstall</h2>
          <p>Remove the zamboni directory.</p>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/guides", html);

    const installChunk = extracted.chunks.find((chunk) => chunk.sectionId === "install");
    const uninstallChunk = extracted.chunks.find((chunk) => chunk.sectionId === "uninstall");

    expect(installChunk?.body).toContain("installer bundle");
    expect(installChunk?.body).not.toContain("zamboni");
    expect(uninstallChunk?.body).toContain("zamboni");
    expect(uninstallChunk?.body).not.toContain("installer bundle");
  });

  test("preserves spaces between adjacent elements", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Features</div>
        <h1>Features</h1>
        <div class="docs-prose">
          <section id="list">
            <h2 id="list">List</h2>
            <ul><li>Alpha</li><li>Beta</li></ul>
          </section>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/features", html);

    const sectionChunk = extracted.chunks.find((chunk) => chunk.sectionId === "list");
    expect(sectionChunk?.body).toContain("Alpha Beta");
    expect(sectionChunk?.body).not.toContain("AlphaBeta");

    const pageChunk = extracted.chunks.find((chunk) => chunk.sectionId === null);
    expect(pageChunk?.body).toContain("Alpha Beta");
    expect(pageChunk?.body).not.toContain("AlphaBeta");
  });

  test("reads section headings whose id lives only on the section wrapper", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Intro</div>
        <h1>Overview</h1>
        <div class="docs-prose">
          <section id="intro">
            <h2>Introduction</h2>
            <p>Welcome to the product.</p>
          </section>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/overview", html);

    const sectionChunk = extracted.chunks.find((chunk) => chunk.sectionId === "intro");
    expect(sectionChunk?.heading).toBe("Introduction");
    expect(sectionChunk?.body).toContain("Welcome to the product");
  });

  test("keeps child h3 content inside a standalone h2 block", () => {
    const html = `
      <div class="docs-main">
        <div class="docs-breadcrumb">Docs / Guides</div>
        <h1>Guides</h1>
        <div class="docs-prose">
          <h2 id="parent">Parent Topic</h2>
          <h3 id="child">Child Detail</h3>
          <p>Child body content here.</p>
          <h2 id="sibling">Sibling Topic</h2>
          <p>Sibling body content.</p>
        </div>
      </div>
    `;

    const extracted = extractDocsPageFromHtml("/docs/guides", html);

    const parentChunk = extracted.chunks.find((chunk) => chunk.sectionId === "parent");
    expect(parentChunk).toBeDefined();
    expect(parentChunk?.body).toContain("Child body content");
    expect(parentChunk?.body).not.toContain("Sibling body content");

    const childChunk = extracted.chunks.find((chunk) => chunk.sectionId === "child");
    expect(childChunk?.body).toContain("Child body content");
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
