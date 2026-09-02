import { afterEach, describe, expect, test } from "bun:test";

import {
  buildVelayLiveVoiceUrl,
  velayHostForPlatformUrl,
  velayWsScheme,
} from "./velay.js";

const ORIGINAL_VELAY_HOST = process.env.VELLUM_VELAY_HOST;

afterEach(() => {
  if (ORIGINAL_VELAY_HOST === undefined) {
    delete process.env.VELLUM_VELAY_HOST;
  } else {
    process.env.VELLUM_VELAY_HOST = ORIGINAL_VELAY_HOST;
  }
});

describe("velayHostForPlatformUrl", () => {
  test("maps a platform host onto its environment's velay", () => {
    delete process.env.VELLUM_VELAY_HOST;
    expect(velayHostForPlatformUrl("https://platform.vellum.ai")).toBe(
      "velay.vellum.ai",
    );
    expect(velayHostForPlatformUrl("https://dev-platform.vellum.ai")).toBe(
      "velay-dev.vellum.ai",
    );
  });

  test("falls back to production velay for a host outside the convention", () => {
    delete process.env.VELLUM_VELAY_HOST;
    // A local platform predicts no velay of its own; guessing one would be
    // worse than dialing the host that certainly exists.
    expect(velayHostForPlatformUrl("http://localhost:8000")).toBe(
      "velay.vellum.ai",
    );
    expect(velayHostForPlatformUrl("not a url")).toBe("velay.vellum.ai");
  });

  test("the env override wins, which is how a local vel up velay is reached", () => {
    process.env.VELLUM_VELAY_HOST = "localhost:8501";
    expect(velayHostForPlatformUrl("https://platform.vellum.ai")).toBe(
      "localhost:8501",
    );
  });
});

describe("velayWsScheme", () => {
  test("downgrades to ws only for loopback", () => {
    expect(velayWsScheme("localhost:8501")).toBe("ws");
    expect(velayWsScheme("127.0.0.1:8501")).toBe("ws");
    expect(velayWsScheme("velay.vellum.ai")).toBe("wss");
  });
});

describe("buildVelayLiveVoiceUrl", () => {
  test("prefixes the assistant id, which is what selects the tunnel", () => {
    delete process.env.VELLUM_VELAY_HOST;
    const url = new URL(
      buildVelayLiveVoiceUrl({
        platformUrl: "https://platform.vellum.ai",
        assistantId: "01a02514-e452-7019-88d5-30828f42cf17",
        token: "tok_abc",
      }),
    );

    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("velay.vellum.ai");
    expect(url.pathname).toBe(
      "/01a02514-e452-7019-88d5-30828f42cf17/v1/live-voice",
    );
    expect(url.searchParams.get("token")).toBe("tok_abc");
  });

  test("encodes a token rather than letting it break the query", () => {
    delete process.env.VELLUM_VELAY_HOST;
    const url = new URL(
      buildVelayLiveVoiceUrl({
        platformUrl: "https://platform.vellum.ai",
        assistantId: "a1",
        token: "a+b/c=&d",
      }),
    );
    expect(url.searchParams.get("token")).toBe("a+b/c=&d");
  });

  test("uses ws against a loopback velay so a local stack is reachable", () => {
    process.env.VELLUM_VELAY_HOST = "localhost:8501";
    const url = new URL(
      buildVelayLiveVoiceUrl({
        platformUrl: "http://localhost:8000",
        assistantId: "a1",
        token: "t",
      }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:8501");
  });
});
