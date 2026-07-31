import { describe, expect, test } from "bun:test";

import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isChannelId,
  isInterfaceId,
  parseInterfaceId,
  type InterfaceId,
} from "../channels.js";

const EXPECTED_INTERFACE_IDS = [
  "macos",
  "ios",
  "cli",
  "telegram",
  "phone",
  "web",
  "whatsapp",
  "slack",
  "email",
  "chrome-extension",
  "a2a",
  "discord",
  "route",
] as const satisfies readonly InterfaceId[];

type MissingInterfaceId = Exclude<
  InterfaceId,
  (typeof EXPECTED_INTERFACE_IDS)[number]
>;
const interfaceTupleIsComplete: MissingInterfaceId extends never
  ? true
  : false = true;

describe("isChannelId", () => {
  test("accepts every canonical channel id", () => {
    for (const id of CHANNEL_IDS) {
      expect(isChannelId(id)).toBe(true);
    }
  });

  test("includes the internal channels no external surface ingresses", () => {
    // `platform` (control plane) and `vellum` (native app) are part of the
    // canonical vocabulary even though the gateway never ingresses them. The
    // gateway's narrower list is a compile-time-asserted subset of this set,
    // so these must remain canonical for that assertion to mean anything.
    expect(isChannelId("platform")).toBe(true);
    expect(isChannelId("vellum")).toBe(true);
  });

  test("includes discord", () => {
    // Discord is canonical vocabulary ahead of its ingress implementation:
    // the gateway's inbound list and the admission-policy seed both derive
    // from CHANNEL_IDS, so it must be here for a Discord message to be
    // routable and to carry an admission floor at all.
    expect(isChannelId("discord")).toBe(true);
  });

  test("rejects unknown strings and non-string values", () => {
    expect(isChannelId("mastodon")).toBe(false);
    expect(isChannelId("")).toBe(false);
    expect(isChannelId(undefined)).toBe(false);
    expect(isChannelId(null)).toBe(false);
    expect(isChannelId(42)).toBe(false);
  });
});

describe("INTERFACE_IDS", () => {
  test("contains the complete canonical interface vocabulary", () => {
    expect(interfaceTupleIsComplete).toBe(true);
    expect(INTERFACE_IDS).toEqual(EXPECTED_INTERFACE_IDS);
  });
});

describe("isInterfaceId", () => {
  test("accepts every canonical interface id", () => {
    for (const id of EXPECTED_INTERFACE_IDS) {
      expect(isInterfaceId(id)).toBe(true);
    }
  });

  test("rejects the legacy alias, unknown strings, and non-string values", () => {
    expect(isInterfaceId("vellum")).toBe(false);
    expect(isInterfaceId("safari-extension")).toBe(false);
    expect(isInterfaceId("")).toBe(false);
    expect(isInterfaceId(undefined)).toBe(false);
    expect(isInterfaceId(null)).toBe(false);
    expect(isInterfaceId(42)).toBe(false);
  });
});

describe("parseInterfaceId", () => {
  test("returns every canonical interface id unchanged", () => {
    for (const id of EXPECTED_INTERFACE_IDS) {
      expect(parseInterfaceId(id)).toBe(id);
    }
  });

  test("normalizes the legacy vellum alias to web", () => {
    expect(parseInterfaceId("vellum")).toBe("web");
  });

  test("rejects unknown strings and non-string values", () => {
    expect(parseInterfaceId("safari-extension")).toBeNull();
    expect(parseInterfaceId("")).toBeNull();
    expect(parseInterfaceId(undefined)).toBeNull();
    expect(parseInterfaceId(null)).toBeNull();
    expect(parseInterfaceId(42)).toBeNull();
  });
});
