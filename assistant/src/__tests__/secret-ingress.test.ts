import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that depend on them
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    child: function () {
      return this;
    },
  }),
}));

import { resetAllowlist } from "../security/secret-allowlist.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkIngressForSecrets", () => {
  beforeEach(() => {
    setConfig("secretDetection", {
      enabled: true,
      blockIngress: true,
    });
    resetAllowlist();
  });

  afterEach(() => {
    resetAllowlist();
  });

  // ── Blocked patterns ───────────────────────────────────────────────

  test("blocks Google OAuth secret (GOCSPX-*)", () => {
    const result = checkIngressForSecrets(
      "My client secret is GOCSPX-abcdefghijklmnopqrstuvwxyz12",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Google OAuth Client Secret");
    expect(result.userNotice).toBeDefined();
  });

  test("blocks GitHub PAT (ghp_*)", () => {
    const result = checkIngressForSecrets(
      "Here is my token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("GitHub Token");
  });

  test("blocks Slack bot token (xoxb-*)", () => {
    const result = checkIngressForSecrets(
      "Use this: xoxb-1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUvWx",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Slack Bot Token");
  });

  test("blocks Anthropic API key (sk-ant-*)", () => {
    const key =
      "sk-ant-api03-abcDefGhiJklMnoPqrStuVwxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj";
    const result = checkIngressForSecrets(`Key: ${key}`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Anthropic API Key");
  });

  test("blocks private key header", () => {
    const result = checkIngressForSecrets(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Private Key");
  });

  test("blocks AWS access key (AKIA*)", () => {
    const result = checkIngressForSecrets("AWS key: AKIAIOSFODNN7EXAMPLE");
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("AWS Access Key");
  });

  test("blocks Stripe secret key (sk_live_*)", () => {
    const result = checkIngressForSecrets("sk_live_abcdefghijklmnopqrstuvwx");
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Stripe Secret Key");
  });

  test("blocks SendGrid API key", () => {
    const result = checkIngressForSecrets(
      "SG.abcdefghijklmnopqrstuv.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("SendGrid API Key");
  });

  test("blocks npm token", () => {
    const result = checkIngressForSecrets(
      "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("npm Token");
  });

  test("blocks OpenAI project key (sk-proj-*)", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
    const result = checkIngressForSecrets(`My key: ${key}`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("OpenAI Project Key");
  });

  test("blocks Google API key (AIza*)", () => {
    const result = checkIngressForSecrets(
      "AIzaSyA0123456789abcdefghijklmnopqrstuvw",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Google API Key");
  });

  test("blocks GitLab PAT (glpat-*)", () => {
    const result = checkIngressForSecrets("glpat-abcdefghijklmnopqrst");
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("GitLab Token");
  });

  test("blocks Telegram Bot Token", () => {
    const result = checkIngressForSecrets(
      "Bot token: 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Telegram Bot Token");
  });

  test("blocks Twilio API Key (SK*)", () => {
    const result = checkIngressForSecrets(
      "Twilio key: SK0123456789abcdef0123456789abcdef",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Twilio API Key");
  });

  // ── Not blocked (excluded patterns) ────────────────────────────────

  test("does not block normal text", () => {
    const result = checkIngressForSecrets(
      "Hello, can you help me set up my project?",
    );
    expect(result.blocked).toBe(false);
    expect(result.detectedTypes).toHaveLength(0);
  });

  test("does not block high-entropy hex (40-char git SHA)", () => {
    const result = checkIngressForSecrets(
      "Commit: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block UUID", () => {
    const result = checkIngressForSecrets(
      "ID: 550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block JWT (eyJ...)", () => {
    const result = checkIngressForSecrets(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block password=mysecretvalue (generic assignment)", () => {
    const result = checkIngressForSecrets(
      'password=mysecretvalue\nsecret="hello world"',
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block postgres connection string", () => {
    const result = checkIngressForSecrets(
      "postgres://user:pass@host:5432/mydb",
    );
    expect(result.blocked).toBe(false);
  });

  // ── Config flags ───────────────────────────────────────────────────

  test("does not block when secretDetection.enabled is false", () => {
    setConfig("secretDetection", {
      enabled: false,
      blockIngress: true,
    });
    const result = checkIngressForSecrets(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block when blockIngress is false", () => {
    setConfig("secretDetection", {
      enabled: true,
      blockIngress: false,
    });
    const result = checkIngressForSecrets(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(false);
  });

  // ── Placeholder / test values ──────────────────────────────────────

  test("does not block placeholder test keys (sk-test-*)", () => {
    const result = checkIngressForSecrets("sk-test-abc123");
    expect(result.blocked).toBe(false);
  });

  test("does not block fake_ prefixed values", () => {
    // A GitHub-like token with fake_ prefix
    const result = checkIngressForSecrets(
      "fake_ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block repeated character patterns", () => {
    // AKIA followed by 16 repeated X characters
    const result = checkIngressForSecrets("AKIAXXXXXXXXXXXXXXXX");
    expect(result.blocked).toBe(false);
  });

  // ── Token-shaped whole-message heuristic ───────────────────────────

  // Synthetic token mirroring the incident's shape (never a real credential).
  const incidentToken = "virlo_tkn_Qm7pW2xLbV9sKjR4tNcY8dZh3Fg";

  test("blocks a whole-message token-shaped value with unknown prefix", () => {
    const result = checkIngressForSecrets(incidentToken);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Token-shaped value");
    expect(result.userNotice).toBeDefined();
  });

  test("blocks a whole-message token-shaped value with surrounding whitespace", () => {
    const result = checkIngressForSecrets(`  ${incidentToken}\n`);
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Token-shaped value");
  });

  test("does not block the same token embedded in a sentence", () => {
    const result = checkIngressForSecrets(
      `Here is the value ${incidentToken} from the docs`,
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block a token-shaped value with a repeated-char tail", () => {
    const result = checkIngressForSecrets("my_key_xxxxxxxxxxxxxxxx");
    expect(result.blocked).toBe(false);
  });

  test("does not block a test_-prefixed token-shaped value", () => {
    const result = checkIngressForSecrets("test_token_abcdefghijklmnop");
    expect(result.blocked).toBe(false);
  });

  test("does not block a whole-message 40-char hex git SHA", () => {
    const result = checkIngressForSecrets(
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block a whole-message UUID", () => {
    const result = checkIngressForSecrets(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result.blocked).toBe(false);
  });

  test("does not block a normal long word", () => {
    const result = checkIngressForSecrets("supercalifragilisticexpialidocious");
    expect(result.blocked).toBe(false);
  });

  test("does not block an allowlisted token-shaped value", () => {
    const dataDir = join(process.env.VELLUM_WORKSPACE_DIR!, "data");
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(
        join(dataDir, "secret-allowlist.json"),
        JSON.stringify({ values: [incidentToken] }),
      );
      resetAllowlist();
      const result = checkIngressForSecrets(incidentToken);
      expect(result.blocked).toBe(false);
    } finally {
      rmSync(join(dataDir, "secret-allowlist.json"), { force: true });
      resetAllowlist();
    }
  });

  test("does not block token-shaped values when blockTokenShapedMessages is false", () => {
    setConfig("secretDetection", {
      enabled: true,
      blockIngress: true,
      blockTokenShapedMessages: false,
    });
    const result = checkIngressForSecrets(incidentToken);
    expect(result.blocked).toBe(false);
  });

  test("prefix-pattern detection takes precedence over the token-shape label", () => {
    const result = checkIngressForSecrets(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toEqual(["GitHub Token"]);
  });

  // ── Multiple secrets ───────────────────────────────────────────────

  test("reports multiple detected types", () => {
    const result = checkIngressForSecrets(
      "AWS: AKIAIOSFODNN7EXAMPLE\nGitHub: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    );
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("AWS Access Key");
    expect(result.detectedTypes).toContain("GitHub Token");
    expect(result.detectedTypes.length).toBe(2);
  });

  test("user notice does not echo secret values", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const result = checkIngressForSecrets(`Key: ${secret}`);
    expect(result.blocked).toBe(true);
    expect(result.userNotice).toBeDefined();
    expect(result.userNotice!).not.toContain(secret);
  });
});
