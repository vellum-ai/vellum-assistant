import { describe, expect, it } from "bun:test";

import {
  buildStoragePolyfill,
  injectBridge,
  injectScript,
  jsonForScript,
  preparePreviewHtml,
} from "@/utils/sandbox-bridge";

const FRAME_ID = "test-frame";

describe("jsonForScript", () => {
  it("escapes </script> to prevent script-context breakout", () => {
    const out = jsonForScript("</script><script>alert(1)</script>");
    expect(out).not.toContain("</script>");
    expect(out).toContain("<\\/script>");
  });

  it("escapes <!-- to prevent HTML comment injection", () => {
    const out = jsonForScript("<!--<script>alert(1)</script>");
    expect(out).not.toContain("<!--");
    expect(out).toContain("<\\!--");
  });
});

describe("buildStoragePolyfill", () => {
  it("produces a script tag with localStorage and sessionStorage shims", () => {
    const out = buildStoragePolyfill();
    expect(out).toContain("<script>");
    expect(out).toContain("</script>");
    expect(out).toContain("localStorage");
    expect(out).toContain("sessionStorage");
    expect(out).toContain("storageShim");
  });
});

describe("injectScript", () => {
  it("injects before the last </body>", () => {
    const html = "<html><body><div>hi</div></body></html>";
    const script = "<script>x</script>";
    const out = injectScript(html, script);
    const bodyClose = out.lastIndexOf("</body>");
    const scriptIdx = out.indexOf("<script>x</script>");
    expect(scriptIdx).toBeGreaterThan(0);
    expect(scriptIdx).toBeLessThan(bodyClose);
  });

  it("uses lastIndexOf so literal </body> in a script doesn't hijack", () => {
    const html = [
      "<html><body>",
      "<script>",
      "// inject before </body>, so wait for it",
      "console.log('app');",
      "</script>",
      "</body></html>",
    ].join("\n");
    const script = "<script>bridge</script>";
    const out = injectScript(html, script);

    const realBodyClose = out.lastIndexOf("</body>");
    const bridgeIdx = out.indexOf("<script>bridge</script>");
    const hostScriptStart = out.indexOf("<script>");

    expect(bridgeIdx).toBeGreaterThan(hostScriptStart);
    expect(bridgeIdx).toBeLessThan(realBodyClose);
    expect(out.indexOf("console.log('app');")).toBeLessThan(out.indexOf("</script>"));
  });

  it("falls back to after </head> when no </body>", () => {
    const html = "<html><head></head>no body";
    const script = "<script>x</script>";
    const out = injectScript(html, script);
    const headClose = out.indexOf("</head>");
    const scriptIdx = out.indexOf("<script>x</script>");
    expect(scriptIdx).toBeGreaterThan(headClose);
  });

  it("prepends when neither tag exists", () => {
    const html = "just a fragment";
    const script = "<script>x</script>";
    const out = injectScript(html, script);
    expect(out.startsWith("<script>x</script>")).toBe(true);
    expect(out.endsWith("just a fragment")).toBe(true);
  });
});

describe("injectBridge", () => {
  it("injects before </body> for a normal document", () => {
    const html = "<!doctype html><html><head></head><body><div>hi</div></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("<div>hi</div>");
    expect(out).toContain("window.vellum");
    const bodyClose = out.lastIndexOf("</body>");
    const bridgeStart = out.indexOf("<script>");
    expect(bridgeStart).toBeGreaterThan(0);
    expect(bridgeStart).toBeLessThan(bodyClose);
  });

  it("falls back to after </head> when no </body> is present", () => {
    const html = "<!doctype html><html><head></head>oops no body";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("window.vellum");
    const headClose = out.indexOf("</head>");
    const bridgeStart = out.indexOf("<script>");
    expect(bridgeStart).toBeGreaterThan(headClose);
  });

  it("prepends the bridge when neither tag exists", () => {
    const html = "just some fragment";
    const out = injectBridge(html, FRAME_ID);
    expect(out.startsWith("<script>")).toBe(true);
    expect(out.endsWith("just some fragment")).toBe(true);
  });

  it("does not hijack the inject site when a script contains a literal </body>", () => {
    const html = [
      "<!doctype html><html><head></head><body>",
      "<div id=root></div>",
      "<script>",
      "// the platform injects right before </body>, so wait for it",
      "console.log('app loaded');",
      "</script>",
      "</body></html>",
    ].join("\n");

    const out = injectBridge(html, FRAME_ID);

    const realBodyClose = out.lastIndexOf("</body>");
    const bridgeStart = out.lastIndexOf("<script>", realBodyClose);
    const hostScriptStart = out.indexOf("<script>");

    expect(bridgeStart).toBeGreaterThan(hostScriptStart);
    expect(bridgeStart).toBeLessThan(realBodyClose);
    const tailIdx = out.indexOf("console.log('app loaded');");
    const hostScriptCloseIdx = out.indexOf("</script>");
    expect(tailIdx).toBeGreaterThan(hostScriptStart);
    expect(tailIdx).toBeLessThan(hostScriptCloseIdx);
  });

  it("serializes the route into the bridge payload", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { route: "deep/link" });
    expect(out).toContain('"deep/link"');
  });

  it("escapes </script> and <!-- in route to prevent script-context escapes", () => {
    const html = "<html><body></body></html>";
    const malicious = "</script><script>alert(1)</script>";
    const out = injectBridge(html, FRAME_ID, { route: malicious });
    expect(out).not.toContain('"</script>');
    expect(out).toContain("<\\/script>");
  });

  it("embeds frameId (not appId or surfaceId) in message payloads", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, "my-frame-123", { fetch: true });
    expect(out).toContain("frameId:");
    expect(out).not.toContain("appId:");
    expect(out).not.toContain("surfaceId:");
  });

  it("includes fetch proxy when fetch option is true", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { fetch: true });
    expect(out).toContain("vellum_fetch_request");
    expect(out).toContain("vellum_fetch_response");
    expect(out).toContain("window.vellum.fetch");
  });

  it("omits fetch proxy by default", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).not.toContain("vellum_fetch_request");
    expect(out).not.toContain("window.vellum.fetch");
  });
});

describe("preparePreviewHtml", () => {
  it("injects both storage polyfill and scrollbar-hiding styles", () => {
    const html = "<html><head></head><body><div>hello</div></body></html>";
    const out = preparePreviewHtml(html);
    expect(out).toContain("storageShim");
    expect(out).toContain("overflow:hidden");
    expect(out).toContain("scrollbar-width:none");
    expect(out).toContain("<div>hello</div>");
  });

  it("handles fragments without head/body tags", () => {
    const html = "<div>content</div>";
    const out = preparePreviewHtml(html);
    expect(out).toContain("storageShim");
    expect(out).toContain("overflow:hidden");
    expect(out).toContain("<div>content</div>");
  });
});
