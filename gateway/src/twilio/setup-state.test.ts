import { describe, expect, test } from "bun:test";

import type { ConfigFileCache } from "../config-file-cache.js";
import { hasTwilioSetupStarted } from "./setup-state.js";

function makeConfigFileCache(twilio: Record<string, unknown>): ConfigFileCache {
  return {
    getBoolean: (section: string, field: string) => {
      if (section !== "twilio") return undefined;
      const value = twilio[field];
      return typeof value === "boolean" ? value : undefined;
    },
    getString: (section: string, field: string) => {
      if (section !== "twilio") return undefined;
      const value = twilio[field];
      return typeof value === "string" ? value || undefined : undefined;
    },
  } as unknown as ConfigFileCache;
}

describe("hasTwilioSetupStarted", () => {
  test("is true when the setup marker is present", () => {
    expect(
      hasTwilioSetupStarted(makeConfigFileCache({ setupStarted: true })),
    ).toBe(true);
  });

  test("is true for existing workspaces with Twilio config", () => {
    expect(
      hasTwilioSetupStarted(makeConfigFileCache({ accountSid: "AC_existing" })),
    ).toBe(true);
    expect(
      hasTwilioSetupStarted(makeConfigFileCache({ phoneNumber: "+15550100" })),
    ).toBe(true);
  });

  test("is true when Twilio credentials are loaded", () => {
    expect(
      hasTwilioSetupStarted(makeConfigFileCache({}), {
        account_sid: "AC_existing",
        auth_token: "token",
      }),
    ).toBe(true);
  });

  test("is false before Twilio setup starts", () => {
    expect(hasTwilioSetupStarted(makeConfigFileCache({}))).toBe(false);
  });
});
