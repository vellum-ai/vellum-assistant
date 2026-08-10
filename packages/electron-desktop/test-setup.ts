import { mock } from "bun:test";

mock.module("electron", () => ({
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: () => undefined },
    },
  },
}));
