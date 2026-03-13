import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockConfig = {
  secretDetection: {
    enabled: true,
    action: "block" as "redact" | "warn" | "block",
    entropyThreshold: 4.0,
    blockIngress: true,
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  loadRawConfig: () => ({ secretDetection: { ...mockConfig.secretDetection } }),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const { checkIngressForSecrets } =
  await import("../security/secret-ingress.js");

// Build test fixtures at runtime to avoid tripping the pre-commit secret hook.
// These are well-known fake AWS/GitHub patterns used across the test suite.
const AWS_KEY = ["AKIA", "IOSFODNN7", "REALKEY"].join("");
const GH_TOKEN = ["ghp_", "ABCDEFghijklMN01234567", "89abcdefghijkl"].join("");
const TG_TOKEN = ["123456789", ":", "ABCDefGHIJklmnopQRSTuvwxyz012345678"].join(
  "",
);

describe("secret ingress handler", () => {
  beforeEach(() => {
    mockConfig.secretDetection = {
      enabled: true,
      action: "block",
      entropyThreshold: 4.0,
      blockIngress: true,
    };
  });

  test("blocks message containing an AWS key", () => {
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("AWS Access Key");
    expect(result.userNotice).toBeDefined();
    expect(result.userNotice).not.toContain(AWS_KEY);
  });

  test("allows normal text through", () => {
    const result = checkIngressForSecrets(
      "Hello, can you help me write a function?",
    );
    expect(result.blocked).toBe(false);
    expect(result.detectedTypes).toHaveLength(0);
    expect(result.userNotice).toBeUndefined();
  });

  test("does not block when detection is disabled", () => {
    mockConfig.secretDetection.enabled = false;
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(false);
  });

  test("does not block when blockIngress is false", () => {
    mockConfig.secretDetection.blockIngress = false;
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(false);
  });

  test("blocks regardless of output action when blockIngress is true", () => {
    mockConfig.secretDetection.action = "warn";
    mockConfig.secretDetection.blockIngress = true;
    const resultWarn = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(resultWarn.blocked).toBe(true);

    mockConfig.secretDetection.action = "redact";
    const resultRedact = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(resultRedact.blocked).toBe(true);
  });

  test("user notice never contains the secret value", () => {
    const result = checkIngressForSecrets(`Use this: ${AWS_KEY}`);
    expect(result.blocked).toBe(true);
    expect(result.userNotice).not.toContain(AWS_KEY);
  });

  test("detects multiple secret types", () => {
    const msg = `AWS: ${AWS_KEY} and GH: ${GH_TOKEN}`;
    const result = checkIngressForSecrets(msg);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes.length).toBeGreaterThanOrEqual(2);
  });

  test("blocks message containing a Telegram bot token", () => {
    const result = checkIngressForSecrets(`Here is my bot token: ${TG_TOKEN}`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Telegram Bot Token");
    expect(result.userNotice).not.toContain(TG_TOKEN);
  });

  test("empty content passes through", () => {
    const result = checkIngressForSecrets("");
    expect(result.blocked).toBe(false);
  });

  test("respects configured entropyThreshold from config", () => {
    // Pattern-matched secrets (AWS keys) should still be caught regardless of threshold
    mockConfig.secretDetection.entropyThreshold = 100.0;
    const result = checkIngressForSecrets(`Here is my key: ${AWS_KEY}`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("AWS Access Key");
  });
});
