import { describe, expect, it } from "bun:test";

import {
  buildLinkInterceptorScript,
  buildStoragePolyfill,
  buildWidgetHeightReporterScript,
  buildWidgetPromptScript,
  buildWidgetWidthFitScript,
  injectBridge,
  injectScript,
  injectWidgetBridge,
  WIDGET_CSP_META,
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
    expect(out.indexOf("console.log('app');")).toBeLessThan(
      out.indexOf("</script>"),
    );
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
    const html =
      '<html><head><meta charset="utf-8"></head><body></body></html>';
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
    const html =
      "<!doctype html><html><head></head><body><div>hi</div></body></html>";
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

  it("normalizes a missing /v1 prefix on custom-route fetch paths", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, FRAME_ID, { fetch: true });
    // The bridge prepends "/v1" to "/x/..." paths so the host's strict
    // "/v1/x/" check accepts callers that omit the version prefix.
    expect(out).toContain("path.indexOf('/x/') === 0");
    expect(out).toContain("'/v1' + path");
  });
});

describe("buildLinkInterceptorScript", () => {
  it("produces a script tag with a click handler", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("<script>");
    expect(out).toContain("</script>");
    expect(out).toContain("addEventListener");
    expect(out).toContain("click");
  });

  it("opens links via window.open with noopener,noreferrer", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("window.open");
    expect(out).toContain("noopener,noreferrer");
  });

  it("only intercepts external URL schemes", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("https?:");
    expect(out).toContain("mailto:");
    expect(out).toContain("tel:");
  });

  it("uses event delegation via bubble phase with defaultPrevented guard", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("tagName === 'A'");
    expect(out).toContain("parentElement");
    // Bubble phase — false as third arg to addEventListener (not capture)
    expect(out).toMatch(/},\s*false\)/);
    expect(out).not.toMatch(/},\s*true\)/);
    // Defers to app handlers that already called preventDefault
    expect(out).toContain("e.defaultPrevented");
  });

  it("does not call stopPropagation", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).not.toContain("stopPropagation");
  });

  it("uses raw href attribute for scheme detection, not el.href", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("getAttribute('href')");
    // Should not reference the resolved el.href property for scheme checks
    expect(out).not.toMatch(/var\s+href\s*=\s*el\.href/);
  });

  it("forwards vellum:// deep links to parent via postMessage", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("vellum_open_link");
    expect(out).toContain("postMessage");
    expect(out).toContain("vellum://");
    // frameId should be embedded in the generated script
    expect(out).toContain(FRAME_ID);
  });

  it("intercepts only the workspace and host vellum:// authorities", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    expect(out).toContain("(workspace|host)");
  });

  it("checks vellum:// scheme before external http(s) schemes", () => {
    const out = buildLinkInterceptorScript(FRAME_ID);
    const vellumIdx = out.indexOf("vellum:");
    const httpIdx = out.indexOf("https?:");
    expect(vellumIdx).toBeGreaterThan(0);
    expect(httpIdx).toBeGreaterThan(0);
    // vellum:// must be checked before the external scheme regex
    expect(vellumIdx).toBeLessThan(httpIdx);
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
    const html =
      "<!doctype html><html><head></head><body><div>hi</div></body></html>";
    const out = injectBridge(html, FRAME_ID);
    const bodyClose = out.lastIndexOf("</body>");
    const interceptorIdx = out.indexOf("window.open");
    expect(interceptorIdx).toBeLessThan(bodyClose);
    expect(interceptorIdx).toBeGreaterThan(0);
  });
});

describe("preparePreviewHtml", () => {
  it("prepends polyfill and styles right after <head>", () => {
    const html =
      "<html><head><meta></head><body><div>hello</div></body></html>";
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
    expect(out.indexOf("storageShim")).toBeLessThan(
      out.indexOf("<div>content</div>"),
    );
  });
});

describe("buildWidgetHeightReporterScript", () => {
  it("posts vellum_widget_height bound to the frame id", () => {
    const out = buildWidgetHeightReporterScript(FRAME_ID);
    expect(out).toContain("<script>");
    expect(out).toContain("vellum_widget_height");
    expect(out).toContain(`frameId: "${FRAME_ID}"`);
    expect(out).toContain("window.parent.postMessage");
  });

  it("observes size changes and coalesces them through a frame", () => {
    const out = buildWidgetHeightReporterScript(FRAME_ID);
    expect(out).toContain("ResizeObserver");
    expect(out).toContain("requestAnimationFrame");
  });

  it("measures the body, not the root element", () => {
    // documentElement.scrollHeight is floored at the viewport, so a widget
    // whose content shrinks could never report a smaller height.
    const out = buildWidgetHeightReporterScript(FRAME_ID);
    expect(out).toContain("document.body");
    expect(out).not.toContain("documentElement");
  });

  it("reports the post-zoom height whichever metric the engine scales", () => {
    // A zoomed element's box-metric properties report layout pixels in some
    // engines and visual pixels in others; the bounding rect is always visual.
    // Scaling the metrics and taking the max lands on the visual height under
    // either reading.
    const out = buildWidgetHeightReporterScript(FRAME_ID);
    expect(out).toContain("body.scrollHeight * zoom");
    expect(out).toContain("body.offsetHeight * zoom");
    expect(out).toContain("body.getBoundingClientRect().height");
  });

  it("escapes a frame id that would break out of the script context", () => {
    const out = buildWidgetHeightReporterScript("</script><script>alert(1)");
    expect(out).toContain("<\\/script>");
    expect(out.indexOf("</script>")).toBe(out.lastIndexOf("</script>"));
  });
});

describe("buildWidgetWidthFitScript", () => {
  it("compares the body's scroll width against the frame viewport", () => {
    const out = buildWidgetWidthFitScript();
    expect(out).toContain("<script>");
    expect(out).toContain("document.body");
    expect(out).toContain("document.documentElement.clientWidth");
    expect(out).toContain("body.scrollWidth");
  });

  it("scales with zoom, which reflows, rather than a transform", () => {
    const out = buildWidgetWidthFitScript();
    expect(out).toContain("body.style.zoom");
    expect(out).not.toContain("transform");
  });

  it("tolerates rounding and stops scaling at the readability floor", () => {
    const out = buildWidgetWidthFitScript();
    expect(out).toContain("var MIN_SCALE = 0.7;");
    expect(out).toContain("var TOLERANCE = 2;");
    expect(out).toContain("if (scale < MIN_SCALE) return;");
  });

  it("re-measures at zoom 1 so repeated passes converge", () => {
    const out = buildWidgetWidthFitScript();
    expect(out).toContain("body.style.zoom = '';");
  });

  it("re-evaluates after layout, load, fonts and resize", () => {
    const out = buildWidgetWidthFitScript();
    expect(out).toContain("requestAnimationFrame");
    expect(out).toContain("window.addEventListener('load', schedule)");
    expect(out).toContain("window.addEventListener('resize', schedule)");
    expect(out).toContain("document.fonts.ready.then(schedule)");
  });

  it("posts nothing to the parent, the zoom is frame-internal", () => {
    const out = buildWidgetWidthFitScript();
    expect(out).not.toContain("postMessage");
    expect(out).not.toContain("frameId");
  });

  it("publishes the applied zoom for the height reporter to read", () => {
    expect(buildWidgetWidthFitScript()).toContain("window.__vellumWidgetZoom");
    expect(buildWidgetHeightReporterScript(FRAME_ID)).toContain(
      "window.__vellumWidgetZoom",
    );
  });
});

describe("buildWidgetPromptScript", () => {
  it("exposes sendPrompt and posts vellum_widget_prompt with the frame id", () => {
    const out = buildWidgetPromptScript(FRAME_ID);
    expect(out).toContain("window.sendPrompt");
    expect(out).toContain("vellum_widget_prompt");
    expect(out).toContain(`frameId: "${FRAME_ID}"`);
  });

  it("coerces and trims the prompt, dropping empty relays", () => {
    const out = buildWidgetPromptScript(FRAME_ID);
    expect(out).toContain("String(text).trim()");
    expect(out).toContain("if (!prompt) return;");
  });

  it("escapes a frame id that would break out of the script context", () => {
    const out = buildWidgetPromptScript("</script><script>alert(1)");
    expect(out).toContain("<\\/script>");
    expect(out.indexOf("</script>")).toBe(out.lastIndexOf("</script>"));
  });
});

describe("injectWidgetBridge", () => {
  it("prepends the polyfill and head markup, appending the widget scripts", () => {
    const html = "<html><head></head><body><div>widget</div></body></html>";
    const out = injectWidgetBridge(
      html,
      FRAME_ID,
      "<style>:root{--a:1}</style>",
    );

    expect(out).toContain("storageShim");
    expect(out).toContain("<style>:root{--a:1}</style>");
    expect(out).toContain("vellum_widget_height");
    expect(out).toContain("window.sendPrompt");
    expect(out).toContain("window.open");
    expect(out).toContain("<div>widget</div>");

    const headOpen = out.indexOf("<head>");
    const stylesIdx = out.indexOf("<style>:root{--a:1}</style>");
    const bodyClose = out.lastIndexOf("</body>");
    expect(stylesIdx).toBeGreaterThan(headOpen);
    expect(stylesIdx).toBeLessThan(out.indexOf("<div>widget</div>"));
    expect(out.indexOf("vellum_widget_height")).toBeLessThan(bodyClose);
  });

  it("puts the network-blocking CSP ahead of every script and the content", () => {
    const out = injectWidgetBridge(
      "<html><head></head><body><div>widget</div></body></html>",
      FRAME_ID,
      "<style>x</style>",
    );
    const cspIdx = out.indexOf(WIDGET_CSP_META);
    expect(cspIdx).toBeGreaterThan(-1);
    expect(out).toContain("default-src 'none'");
    expect(cspIdx).toBeLessThan(out.indexOf("<script>"));
    expect(cspIdx).toBeLessThan(out.indexOf("<div>widget</div>"));
  });

  it("runs the shrink-to-fit pass ahead of the height reporter", () => {
    const out = injectWidgetBridge("<svg></svg>", FRAME_ID);
    const fitIdx = out.indexOf("window.__vellumWidgetZoom = 1");
    expect(fitIdx).toBeGreaterThan(-1);
    expect(fitIdx).toBeLessThan(out.indexOf("vellum_widget_height"));
  });

  it("omits the fetch proxy — a visual is not an app", () => {
    const out = injectWidgetBridge("<div>widget</div>", FRAME_ID);
    expect(out).not.toContain("vellum_fetch_request");
    expect(out).not.toContain("window.vellum");
  });

  it("handles fragments without head/body tags", () => {
    const out = injectWidgetBridge("<svg></svg>", FRAME_ID, "<style>x</style>");
    expect(out.startsWith(WIDGET_CSP_META)).toBe(true);
    expect(out).toContain("<svg></svg>");
    expect(out.indexOf("<style>x</style>")).toBeLessThan(
      out.indexOf("<svg></svg>"),
    );
    expect(out.indexOf("vellum_widget_height")).toBeGreaterThan(
      out.indexOf("<svg></svg>"),
    );
  });
});
