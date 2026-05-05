import { describe, expect, test } from "bun:test";

import {
  _isPlaceholder,
  redactSecrets,
  scanText,
  type SecretMatch,
} from "../security/secret-scanner.js";

// ---------------------------------------------------------------------------
// Helper: assert a single match of the expected type
// ---------------------------------------------------------------------------
function expectMatch(text: string, expectedType: string): SecretMatch {
  const matches = scanText(text);
  const found = matches.find((m) => m.type === expectedType);
  expect(found).toBeDefined();
  return found!;
}

function expectNoMatch(text: string): void {
  const matches = scanText(text);
  expect(matches).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------
describe("AWS keys", () => {
  test("detects AWS access key ID", () => {
    expectMatch("aws_access_key_id = AKIAIOSFODNN7REALKEY", "AWS Access Key");
  });

  test("does not flag the AWS example key", () => {
    const matches = scanText("AKIAIOSFODNN7EXAMPLE");
    const aws = matches.filter((m) => m.type === "AWS Access Key");
    expect(aws).toHaveLength(0);
  });

  test("detects AWS secret key after separator", () => {
    // Exactly 40 base-64 chars with mixed case and / (distinguishes from hex)
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYRE+LK3Yzab";
    expect(secret.length).toBe(40);
    expectMatch(`aws_secret_access_key = "${secret}"`, "AWS Secret Key");
  });

  test("does not flag AWS example secret key", () => {
    const matches = scanText(
      'secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    );
    const aws = matches.filter((m) => m.type === "AWS Secret Key");
    expect(aws).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
describe("GitHub tokens", () => {
  test("detects ghp_ personal access token", () => {
    expectMatch(`token=ghp_${"A".repeat(36)}`, "GitHub Token");
  });

  test("detects gho_ OAuth token", () => {
    expectMatch(`gho_${"B".repeat(36)}`, "GitHub Token");
  });

  test("detects fine-grained PAT", () => {
    expectMatch(`github_pat_${"C".repeat(30)}`, "GitHub Fine-Grained PAT");
  });
});

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------
describe("GitLab tokens", () => {
  test("detects glpat- token", () => {
    expectMatch("glpat-abcDEF1234567890abcde", "GitLab Token");
  });
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
describe("Stripe keys", () => {
  test("detects live secret key", () => {
    expectMatch(`sk_live_${"a".repeat(24)}`, "Stripe Secret Key");
  });

  test("detects live restricted key", () => {
    expectMatch(`rk_live_${"b".repeat(24)}`, "Stripe Restricted Key");
  });

  test("does not flag test keys", () => {
    const matches = scanText(`sk_test_${"c".repeat(24)}`);
    const stripe = matches.filter((m) => m.type === "Stripe Secret Key");
    expect(stripe).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
describe("Slack tokens", () => {
  test("detects bot token", () => {
    expectMatch(
      "xoxb-1234567890-1234567890-aBcDeFgHiJkLmNoPqRsTuVwX",
      "Slack Bot Token",
    );
  });

  test("detects webhook URL", () => {
    expectMatch(
      "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
      "Slack Webhook",
    );
  });
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
describe("Telegram bot tokens", () => {
  // Build test token at runtime to avoid tripping pre-commit secret hook
  const BOT_TOKEN = [
    "123456789",
    ":",
    "ABCDefGHIJklmnopQRSTuvwxyz012345678",
  ].join("");

  test("detects Telegram bot token", () => {
    expectMatch(`token=${BOT_TOKEN}`, "Telegram Bot Token");
  });

  test("detects bot token in surrounding text", () => {
    expectMatch(
      `My bot token is ${BOT_TOKEN} please save it`,
      "Telegram Bot Token",
    );
  });

  test("detects bot token ending with hyphen", () => {
    // ~1.5% of valid tokens end with '-'; trailing \b would miss these
    const tokenEndingHyphen = [
      "123456789",
      ":",
      "ABCDefGHIJklmnopQRSTuvwxyz01234567-",
    ].join("");
    expectMatch(`token=${tokenEndingHyphen}`, "Telegram Bot Token");
  });

  test("does not flag short numeric:alpha strings", () => {
    // Too few digits in bot ID (only 5)
    const matches = scanText("12345:ABCDefGHIJklmnopQRSTuvwxyz012345678");
    const telegram = matches.filter((m) => m.type === "Telegram Bot Token");
    expect(telegram).toHaveLength(0);
  });

  test("does not flag token with wrong secret length", () => {
    // Secret part is only 10 chars (needs 35)
    const matches = scanText("123456789:ABCDefGHIJ");
    const telegram = matches.filter((m) => m.type === "Telegram Bot Token");
    expect(telegram).toHaveLength(0);
  });

  test("does not flag token with too-long secret part", () => {
    // Secret part is 40 chars (needs exactly 35)
    const matches = scanText(
      "123456789:ABCDefGHIJklmnopQRSTuvwxyz0123456789AB",
    );
    const telegram = matches.filter((m) => m.type === "Telegram Bot Token");
    expect(telegram).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
describe("Anthropic keys", () => {
  test("detects sk-ant- key", () => {
    expectMatch(`sk-ant-${"a".repeat(80)}`, "Anthropic API Key");
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
describe("OpenAI keys", () => {
  test("detects sk-proj- key", () => {
    expectMatch(`sk-proj-${"a".repeat(40)}`, "OpenAI Project Key");
  });

  test("detects classic OpenAI key format", () => {
    expectMatch(
      `sk-${"a".repeat(20)}T3BlbkFJ${"b".repeat(20)}`,
      "OpenAI API Key",
    );
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------
describe("Google keys", () => {
  test("detects AIza key", () => {
    // AIza + exactly 35 alphanumeric/dash/underscore chars
    const key = "AIza" + "SyA1bcDefGHijklMnoPQRStuvWXyz012345";
    expect(key.slice(4).length).toBe(35);
    expectMatch(key, "Google API Key");
  });

  test("detects GOCSPX- client secret", () => {
    // GOCSPX- + exactly 28 chars
    const key = "GOCSPX-" + "aBcDeFgHiJkLmNoPqRsTuVwXy123";
    expect(key.slice(7).length).toBe(28);
    expectMatch(key, "Google OAuth Client Secret");
  });
});

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------
describe("Twilio keys", () => {
  test("detects SK key", () => {
    expectMatch(`SK${"a".repeat(32)}`, "Twilio API Key");
  });
});

// ---------------------------------------------------------------------------
// SendGrid
// ---------------------------------------------------------------------------
describe("SendGrid keys", () => {
  test("detects SG. key", () => {
    expectMatch(`SG.${"a".repeat(22)}.${"b".repeat(43)}`, "SendGrid API Key");
  });
});

// ---------------------------------------------------------------------------
// Mailgun
// ---------------------------------------------------------------------------
describe("Mailgun keys", () => {
  test("detects key- format", () => {
    expectMatch(`key-${"c".repeat(32)}`, "Mailgun API Key");
  });
});

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------
describe("npm tokens", () => {
  test("detects npm_ token", () => {
    expectMatch(`npm_${"d".repeat(36)}`, "npm Token");
  });
});

// ---------------------------------------------------------------------------
// PyPI
// ---------------------------------------------------------------------------
describe("PyPI tokens", () => {
  test("detects pypi- token", () => {
    expectMatch(`pypi-${"e".repeat(50)}`, "PyPI API Token");
  });
});

// ---------------------------------------------------------------------------
// Private keys
// ---------------------------------------------------------------------------
describe("private keys", () => {
  test("detects RSA private key header", () => {
    expectMatch("-----BEGIN RSA PRIVATE KEY-----\nMIIE...", "Private Key");
  });

  test("detects generic private key header", () => {
    expectMatch("-----BEGIN PRIVATE KEY-----\nMIIE...", "Private Key");
  });

  test("detects EC private key header", () => {
    expectMatch("-----BEGIN EC PRIVATE KEY-----\nMIIE...", "Private Key");
  });

  test("detects OPENSSH private key header", () => {
    expectMatch(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz...",
      "Private Key",
    );
  });
});

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------
describe("JSON Web Tokens", () => {
  test("detects JWT", () => {
    // A structurally valid JWT (base64url-encoded header.payload.signature)
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload =
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const signature = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expectMatch(`${header}.${payload}.${signature}`, "JSON Web Token");
  });
});

// ---------------------------------------------------------------------------
// Connection strings
// ---------------------------------------------------------------------------
describe("connection strings", () => {
  test("detects postgres connection string", () => {
    expectMatch(
      "postgres://user:secret@db.example.com:5432/mydb",
      "Database Connection String",
    );
  });

  test("detects mongodb+srv connection string", () => {
    expectMatch(
      "mongodb+srv://user:password@cluster.mongodb.net/db",
      "Database Connection String",
    );
  });

  test("detects redis connection string", () => {
    expectMatch(
      "redis://default:password@redis.example.com:6379",
      "Database Connection String",
    );
  });

  test("detects mysql connection string", () => {
    expectMatch(
      "mysql://root:secret@localhost:3306/app",
      "Database Connection String",
    );
  });
});

// ---------------------------------------------------------------------------
// Generic secret assignment
// ---------------------------------------------------------------------------
describe("generic secret assignments", () => {
  test('detects password = "value"', () => {
    expectMatch('password = "SuperSecret123!"', "Generic Secret Assignment");
  });

  test('detects api_key: "value"', () => {
    expectMatch(
      "api_key: 'my-real-api-key-value'",
      "Generic Secret Assignment",
    );
  });

  test("detects SECRET=value in quotes", () => {
    expectMatch(
      'SECRET="a-very-long-secret-value"',
      "Generic Secret Assignment",
    );
  });

  test("ignores short values (< 8 chars)", () => {
    // "short" is only 5 chars, should not match generic pattern
    const matches = scanText('password = "short"');
    const generic = matches.filter(
      (m) => m.type === "Generic Secret Assignment",
    );
    expect(generic).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Placeholder / false-positive suppression
// ---------------------------------------------------------------------------
describe("placeholder detection", () => {
  test("suppresses known placeholder values", () => {
    expectNoMatch('password = "changeme"');
    expectNoMatch('password = "password"');
    expectNoMatch('password = "xxxxxxxx"');
  });

  test("suppresses test-prefixed keys", () => {
    expectNoMatch(`sk_test_${"a".repeat(24)}`);
    expectNoMatch(`pk_test_${"b".repeat(24)}`);
  });

  test("suppresses values containing example/placeholder/dummy", () => {
    expectNoMatch('token = "my-example-api-key-value"');
    expectNoMatch('key = "this-is-a-placeholder-string"');
    expectNoMatch('secret = "dummy-value-for-testing"');
  });

  test("suppresses all-same-character strings", () => {
    expectNoMatch('password = "aaaaaaaa"');
  });

  test("isPlaceholder returns true for known values", () => {
    expect(_isPlaceholder("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(_isPlaceholder("your-api-key-here")).toBe(true);
    expect(_isPlaceholder("changeme")).toBe(true);
  });

  test("isPlaceholder returns false for real-looking values", () => {
    expect(_isPlaceholder("wJalrXUtnFEMI/K7MDENG/bPxRfiCYREALKEY")).toBe(false);
    expect(_isPlaceholder("sk_live_abcdefghij1234567890abcd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
describe("redaction", () => {
  test("redactSecrets replaces secrets in text", () => {
    const input = `export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7REALKEY`;
    const result = redactSecrets(input);
    expect(result).toContain('<redacted type="AWS Access Key" />');
    expect(result).not.toContain("AKIAIOSFODNN7REALKEY");
  });

  test("redactSecrets preserves text without secrets", () => {
    const input = "Hello world, this is safe text.";
    expect(redactSecrets(input)).toBe(input);
  });

  test("redactSecrets handles multiple secrets", () => {
    const input = `
      AWS_KEY=AKIAIOSFODNN7REALKEY
      TOKEN=ghp_${"A".repeat(36)}
    `;
    const result = redactSecrets(input);
    expect(result).toContain('<redacted type="AWS Access Key" />');
    expect(result).toContain('<redacted type="GitHub Token" />');
  });
});

// ---------------------------------------------------------------------------
// scanText behavior
// ---------------------------------------------------------------------------
describe("scanText", () => {
  test("returns empty array for safe text", () => {
    expect(scanText("just normal text with no secrets")).toHaveLength(0);
  });

  test("returns matches sorted by position", () => {
    const input = `second=ghp_${"A".repeat(36)} first=AKIAIOSFODNN7REALKEY`;
    const matches = scanText(input);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].startIndex).toBeGreaterThanOrEqual(
        matches[i - 1].startIndex,
      );
    }
  });

  test("does not flag common code patterns", () => {
    // git SHA (40 hex chars) should not be flagged as AWS secret
    // since it lacks a preceding separator
    const sha = "4b825dc642cb6eb9a060e54bf899d15f13fe1d7a";
    const matches = scanText(`commit ${sha}`);
    const awsMatches = matches.filter((m) => m.type === "AWS Secret Key");
    expect(awsMatches).toHaveLength(0);
  });

  test("handles multi-line input", () => {
    const input = `
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWep4PAtGoSNQ==
-----END RSA PRIVATE KEY-----
    `;
    expectMatch(input, "Private Key");
  });

  test("handles empty string", () => {
    expect(scanText("")).toHaveLength(0);
  });

  test("handles very long text without crashing", () => {
    const longText = "a".repeat(100_000);
    const start = performance.now();
    scanText(longText);
    const elapsed = performance.now() - start;
    // Should complete in under 500ms even for 100KB
    expect(elapsed).toBeLessThan(500);
  });

  test("match includes correct startIndex and endIndex", () => {
    const prefix = "key is: ";
    const key = "AKIAIOSFODNN7REALKEY";
    const input = prefix + key;
    const match = expectMatch(input, "AWS Access Key");
    expect(match.startIndex).toBe(prefix.length);
    expect(match.endIndex).toBe(prefix.length + key.length);
    expect(input.slice(match.startIndex, match.endIndex)).toBe(key);
  });
});

// ---------------------------------------------------------------------------
// Edge cases / false positives
// ---------------------------------------------------------------------------
describe("false positive resistance", () => {
  test("does not flag base64-encoded images", () => {
    // A typical short base64 image data chunk — should not trigger
    const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA";
    const matches = scanText(img);
    // May match JWT-like patterns; verify no AWS/generic matches
    const sensitive = matches.filter(
      (m) =>
        m.type === "AWS Secret Key" || m.type === "Generic Secret Assignment",
    );
    expect(sensitive).toHaveLength(0);
  });

  test("does not flag UUIDs as Heroku keys when they are zero-filled", () => {
    const matches = scanText("00000000-0000-0000-0000-000000000000");
    const heroku = matches.filter((m) => m.type === "Heroku API Key");
    expect(heroku).toHaveLength(0);
  });

  test("does not flag common hex strings without context", () => {
    // MD5/SHA hashes are hex but should not be flagged
    expectNoMatch("d41d8cd98f00b204e9800998ecf8427e");
  });

  test("does not flag public key headers", () => {
    const pubKey = "-----BEGIN PUBLIC KEY-----";
    const matches = scanText(pubKey);
    const privKeys = matches.filter((m) => m.type === "Private Key");
    expect(privKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pass-through cases (allowlist-shaped strings that look secret-ish)
// ---------------------------------------------------------------------------
describe("pass-through behavior", () => {
  test("does not redact Telegram invite deep links", () => {
    const invite =
      "https://t.me/credence_the_bot?start=iv_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE";
    const input = `Here is your invite link: ${invite}`;
    const matches = scanText(input);
    expect(matches).toHaveLength(0);
    expect(redactSecrets(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Overlapping match handling in redactSecrets (#166 feedback)
// ---------------------------------------------------------------------------
describe("overlapping match redaction", () => {
  test("does not corrupt output when matches overlap", () => {
    // An AWS key inside a generic secret assignment produces overlapping matches
    const input = `api_key = "AKIAIOSFODNN7REALKEY"`;
    const result = redactSecrets(input);
    // Should redact correctly without duplicating markers or losing text
    expect(result).not.toContain("AKIAIOSFODNN7REALKEY");
    // The outer quotes should be preserved somewhere in the output
    expect(result).toContain('<redacted type="');
  });

  test("skips nested match and preserves surrounding text", () => {
    // Construct a case where a specific match is entirely inside a broader one
    const input = `password = "AKIAIOSFODNN7REALKEY inside text"`;
    const result = redactSecrets(input);
    // Should have at least one redaction
    expect(result).toContain('<redacted type="');
    // Should not contain the raw key
    expect(result).not.toContain("AKIAIOSFODNN7REALKEY");
  });

  test("wider overlapping match extends redaction span (#172 feedback)", () => {
    // A shorter match (e.g. AWS-like 40 chars) inside a longer generic assignment
    // should not leak the suffix of the longer match
    const input = `password = "AKIAIOSFODNN7REALKEY extra-tail-secret"`;
    const result = redactSecrets(input);
    // Nothing from the original secret value should leak
    expect(result).not.toContain("extra-tail-secret");
    expect(result).not.toContain("AKIAIOSFODNN7REALKEY");
    expect(result).toContain('<redacted type="');
  });

  test("wider match at same start position wins", () => {
    // When two matches start at same offset, wider one should be used
    const input = `token = "AKIAIOSFODNN7REALKEY-plus-extra-data"`;
    const result = redactSecrets(input);
    expect(result).not.toContain("AKIAIOSFODNN7REALKEY");
    expect(result).not.toContain("plus-extra-data");
    expect(result).toContain('<redacted type="');
  });
});

// ---------------------------------------------------------------------------
// Heroku UUID context requirement (#166 feedback)
// ---------------------------------------------------------------------------
describe("Heroku API Key", () => {
  test("detects UUID with heroku context keyword", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const input = `HEROKU_API_KEY=${uuid}`;
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === "Heroku API Key");
    expect(heroku).toHaveLength(1);
  });

  test("detects UUID with heroku_auth_token prefix", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const input = `heroku_auth_token = "${uuid}"`;
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === "Heroku API Key");
    expect(heroku).toHaveLength(1);
  });

  test("does not flag random UUIDs without heroku context", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const input = `request_id: ${uuid}`;
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === "Heroku API Key");
    expect(heroku).toHaveLength(0);
  });

  test("does not flag UUIDs in logs", () => {
    const input =
      "Processed request id=a1b2c3d4-e5f6-7890-abcd-ef1234567890 in 42ms";
    const matches = scanText(input);
    const heroku = matches.filter((m) => m.type === "Heroku API Key");
    expect(heroku).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unquoted generic secret assignments (#166 feedback)
// ---------------------------------------------------------------------------
describe("unquoted generic secret assignments", () => {
  test("detects .env-style unquoted password", () => {
    const input = "DATABASE_PASSWORD=supersecret123";
    const matches = scanText(input);
    const generic = matches.filter(
      (m) => m.type === "Generic Secret Assignment",
    );
    expect(generic.length).toBeGreaterThan(0);
  });

  test("detects .env-style unquoted api key", () => {
    const input = "API_KEY=abcdef1234567890";
    const matches = scanText(input);
    const generic = matches.filter(
      (m) => m.type === "Generic Secret Assignment",
    );
    expect(generic.length).toBeGreaterThan(0);
  });

  test("detects unquoted token assignment", () => {
    const input = "AUTH_TOKEN=mysecuretokenvalue123";
    const matches = scanText(input);
    const generic = matches.filter(
      (m) => m.type === "Generic Secret Assignment",
    );
    expect(generic.length).toBeGreaterThan(0);
  });

  test("still detects quoted assignments", () => {
    const input = `secret = "mysupersecretsecret"`;
    const matches = scanText(input);
    const generic = matches.filter(
      (m) => m.type === "Generic Secret Assignment",
    );
    expect(generic.length).toBeGreaterThan(0);
  });

  test("does not match short unquoted values", () => {
    const input = "password=short";
    const matches = scanText(input);
    const generic = matches.filter(
      (m) => m.type === "Generic Secret Assignment",
    );
    expect(generic).toHaveLength(0);
  });
});
