import { describe, expect, it } from "bun:test";

import {
  buildLinkInterceptorScript,
  buildStoragePolyfill,
  injectBridge,
  injectScript,
  jsonForScript,
  preparePreviewHtml,
  prependScript,
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

describe("prependScript", () => {
  it("injects right after <head>", () => {
    const html = "<html><head><meta charset=\"utf-8\"></head><body></body></html>";
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    const headOpen = out.indexOf("<head>");
    const scriptIdx = out.indexOf("<script>early</script>");
    expect(scriptIdx).toBe(headOpen + "<head>".length);
  });

  it("falls back to after <html> when no <head>", () => {
    const html = "<html><body></body></html>";
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    const htmlOpen = out.indexOf("<html>");
    const scriptIdx = out.indexOf("<script>early</script>");
    expect(scriptIdx).toBe(htmlOpen + "<html>".length);
  });

  it("prepends when neither <head> nor <html> exists", () => {
    const html = "just a fragment";
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    expect(out.startsWith("<script>early</script>")).toBe(true);
    expect(out.endsWith("just a fragment")).toBe(true);
  });

  it("handles <head> with attributes", () => {
    const html = '<html><head lang="en"><meta></head><body></body></html>';
    const script = "<script>early</script>";
    const out = prependScript(html, script);
    const headEnd = out.indexOf('lang="en">') + 'lang="en">'.length;
    const scriptIdx = out.indexOf("<script>early</script>");
    expect(scriptIdx).toBe(headEnd);
  });
});

describe("injectBridge", () => {
  it("prepends polyfill in <head> and appends bridge logic before </body>", () => {
    const html = "<!doctype html><html><head></head><body><div>hi</div></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("<div>hi</div>");
    expect(out).toContain("window.vellum");
    expect(out).toContain("storageShim");

    const headOpen = out.indexOf("<head>");
    const headClose = out.indexOf("</head>");
    const bodyClose = out.lastIndexOf("</body>");

    const polyfillIdx = out.indexOf("storageShim");
    const bridgeIdx = out.indexOf("window.vellum");

    expect(polyfillIdx).toBeGreaterThan(headOpen);
    expect(polyfillIdx).toBeLessThan(headClose);
    expect(bridgeIdx).toBeLessThan(bodyClose);
    expect(bridgeIdx).toBeGreaterThan(headClose);
  });

  it("falls back to prepending when no <head> or </body>", () => {
    const html = "just some fragment";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("storageShim");
    expect(out).toContain("window.vellum");
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
    const vellumIdx = out.indexOf("window.vellum");
    expect(vellumIdx).toBeLessThan(realBodyClose);

    const appCode = out.indexOf("console.log('app loaded');");
    expect(appCode).toBeGreaterThan(0);
    expect(out).toContain("console.log('app loaded');");
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

describe("buildLinkInterceptorScript", () => {
  it("produces a script tag with a click handler", () => {
    const out = buildLinkInterceptorScript();
    expect(out).toContain("<script>");
    expect(out).toContain("</script>");
    expect(out).toContain("addEventListener");
    expect(out).toContain("click");
  });

  it("opens links via window.open with noopener,noreferrer", () => {
    const out = buildLinkInterceptorScript();
    expect(out).toContain("window.open");
    expect(out).toContain("noopener,noreferrer");
  });

  it("only intercepts external URL schemes", () => {
    const out = buildLinkInterceptorScript();
    expect(out).toContain("https?:");
    expect(out).toContain("mailto:");
    expect(out).toContain("tel:");
  });

  it("uses event delegation via capture phase", () => {
    const out = buildLinkInterceptorScript();
    expect(out).toContain("tagName === 'A'");
    expect(out).toContain("parentElement");
    // Capture flag — true as third arg to addEventListener
    expect(out).toMatch(/},\s*true\)/);
  });
});

describe("injectBridge — link interceptor", () => {
  it("includes the link interceptor in the bridge output", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID);
    expect(out).toContain("window.open");
    expect(out).toContain("noopener,noreferrer");
  });

  it("injects the link interceptor before </body> alongside bridge logic", () => {
    const html = "<!doctype html><html><head></head><body><div>hi</div></body></html>";
    const out = injectBridge(html, FRAME_ID);
    const bodyClose = out.lastIndexOf("</body>");
    const interceptorIdx = out.indexOf("window.open");
    expect(interceptorIdx).toBeLessThan(bodyClose);
    expect(interceptorIdx).toBeGreaterThan(0);
  });
});

describe("preparePreviewHtml", () => {
  it("prepends polyfill and styles right after <head>", () => {
    const html = "<html><head><meta></head><body><div>hello</div></body></html>";
    const out = preparePreviewHtml(html);
    expect(out).toContain("storageShim");
    expect(out).toContain("overflow:hidden");
    expect(out).toContain("scrollbar-width:none");
    expect(out).toContain("<div>hello</div>");

    const headOpen = out.indexOf("<head>");
    const polyfillIdx = out.indexOf("storageShim");
    const metaIdx = out.indexOf("<meta>");
    expect(polyfillIdx).toBeGreaterThan(headOpen);
    expect(polyfillIdx).toBeLessThan(metaIdx);
  });

  it("handles fragments without head/body tags", () => {
    const html = "<div>content</div>";
    const out = preparePreviewHtml(html);
    expect(out).toContain("storageShim");
    expect(out).toContain("overflow:hidden");
    expect(out).toContain("<div>content</div>");
    expect(out.indexOf("storageShim")).toBeLessThan(out.indexOf("<div>content</div>"));
  });
});
