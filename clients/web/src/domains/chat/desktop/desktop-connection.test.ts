/**
 * The desktop stream's close-code contract, plus one smoke test that the
 * route resolves through the shared gateway resolver (whose routing rules are
 * covered in `live-voice/connection.test.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

import {
  desktopEndReasonForClose,
  resolveDesktopStreamWsUrl,
} from "./desktop-connection";

afterEach(() => {
  setSelfHostedConnection(null);
});

describe("resolving the desktop stream URL", () => {
  test("dials the desktop route on the gateway", async () => {
    setSelfHostedConnection({
      url: "http://localhost:8500",
      token: "actor-jwt",
    });

    const url = new URL(await resolveDesktopStreamWsUrl("asst-1"));

    expect(url.origin).toBe("ws://localhost:8500");
    expect(url.pathname).toBe("/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("actor-jwt");
  });
});

describe("what a close code means", () => {
  test("4013 is another viewer holding the slot", () => {
    expect(desktopEndReasonForClose(4013)).toBe("busy");
  });

  test("4008 is an assistant with no desktop to serve", () => {
    expect(desktopEndReasonForClose(4008)).toBe("unavailable");
  });

  test("4011 is a desktop that did not start", () => {
    expect(desktopEndReasonForClose(4011)).toBe("failed");
  });

  test("velay's 1013 tunnel drop is a lost connection, not a busy desktop", () => {
    expect(desktopEndReasonForClose(1013)).toBe("lost");
  });

  test("anything else is a connection worth retrying", () => {
    expect(desktopEndReasonForClose(1000)).toBe("lost");
    expect(desktopEndReasonForClose(1006)).toBe("lost");
    expect(desktopEndReasonForClose(3001)).toBe("lost");
  });
});
