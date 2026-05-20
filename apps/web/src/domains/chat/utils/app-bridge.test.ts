import { describe, expect, it } from "bun:test";

import { injectBridge } from "@/domains/chat/utils/app-bridge.js";

const APP_ID = "test-app";

describe("injectBridge", () => {
  it("injects before </body> for a normal document", () => {
    const html = "<!doctype html><html><head></head><body><div>hi</div></body></html>";
    const out = injectBridge(html, APP_ID);
    expect(out).toContain("<div>hi</div>");
    expect(out).toContain("window.vellum");
    // The bridge sits between the content and the real body close.
    const bodyClose = out.lastIndexOf("</body>");
    const bridgeStart = out.indexOf("<script>");
    expect(bridgeStart).toBeGreaterThan(0);
    expect(bridgeStart).toBeLessThan(bodyClose);
  });

  it("falls back to after </head> when no </body> is present", () => {
    const html = "<!doctype html><html><head></head>oops no body";
    const out = injectBridge(html, APP_ID);
    expect(out).toContain("window.vellum");
    const headClose = out.indexOf("</head>");
    const bridgeStart = out.indexOf("<script>");
    expect(bridgeStart).toBeGreaterThan(headClose);
  });

  it("prepends the bridge when neither tag exists", () => {
    const html = "just some fragment";
    const out = injectBridge(html, APP_ID);
    expect(out.startsWith("<script>")).toBe(true);
    expect(out.endsWith("just some fragment")).toBe(true);
  });

  // Regression: the Twitter Monitor app shipped a JS comment that mentioned
  // "</body>" literally. A first-match `replace` would inject the bridge
  // mid-script, then the bridge's own `</script>` would terminate the host
  // script and spill its tail into the body as text. lastIndexOf prevents
  // this by anchoring on the real (last) close tag.
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

    const out = injectBridge(html, APP_ID);

    // The script tag must remain intact: its `console.log` line is still
    // inside a script context, not bleeding into the body.
    const realBodyClose = out.lastIndexOf("</body>");
    const bridgeStart = out.lastIndexOf("<script>", realBodyClose);
    const hostScriptStart = out.indexOf("<script>");

    // Two <script> tags total (host + injected bridge), in that order.
    expect(bridgeStart).toBeGreaterThan(hostScriptStart);
    // Bridge precedes the real body close.
    expect(bridgeStart).toBeLessThan(realBodyClose);
    // Host script's tail content survives intact, in order.
    const tailIdx = out.indexOf("console.log('app loaded');");
    const hostScriptCloseIdx = out.indexOf("</script>");
    expect(tailIdx).toBeGreaterThan(hostScriptStart);
    expect(tailIdx).toBeLessThan(hostScriptCloseIdx);
  });

  it("serializes the route into the bridge payload", () => {
    const html = "<html><body></body></html>";
    const out = injectBridge(html, APP_ID, "deep/link");
    expect(out).toContain('"deep/link"');
  });

  it("escapes </script> and <!-- in route to prevent script-context escapes", () => {
    const html = "<html><body></body></html>";
    const malicious = "</script><script>alert(1)</script>";
    const out = injectBridge(html, APP_ID, malicious);
    // The literal </script> must not appear unescaped inside the bridge.
    expect(out).not.toContain('"</script>');
    // It should be escaped to <\/script>.
    expect(out).toContain("<\\/script>");
  });
});
