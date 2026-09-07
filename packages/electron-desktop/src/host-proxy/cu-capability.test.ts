import { expect, test } from "bun:test";
import { createHostProxyClientHeaders } from "./router";

const identity = { getClientId: () => "mac-1", getMachineName: () => "Test Mac", interfaceId: "macos" };

test("window capture is explicitly advertised by updated clients only", () => {
  expect(createHostProxyClientHeaders(identity).sseClientHeaders()).not.toHaveProperty("X-Vellum-Cu-Window-Capture");
  expect(createHostProxyClientHeaders({ ...identity, supportsWindowCapture: true }).sseClientHeaders()).toHaveProperty("X-Vellum-Cu-Window-Capture", "1");
});
