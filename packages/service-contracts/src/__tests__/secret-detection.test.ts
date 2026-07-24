import { describe, expect, test } from "bun:test";

// Self-referencing package import — proves the `./secret-detection` subpath
// export resolves for consumers.
import * as subpathExport from "@vellumai/service-contracts/secret-detection";

import {
  detectSecretsInText,
  isCompletePrivateKeyBlock,
  PEM_REDACTION_MAX_BODY_LENGTH,
  PREFIX_PATTERNS,
  PRIVATE_KEY_REDACTION_REGEX,
  REDACTION_PREFIX_PATTERNS,
  TOKEN_SHAPE,
  TOKEN_SHAPE_LABEL,
  TOKEN_SHAPE_MAX_LENGTH,
} from "../secret-detection.js";

// All fixtures below are synthetic lookalike tokens — never real key material.

function matchingLabels(text: string): string[] {
  return PREFIX_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.label);
}

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Lowercase-alphanumeric filler of the given length (no separators, so it
 * can never form another pattern's prefix like `npm_` or `key-`). */
function filler(length: number): string {
  return ALNUM.repeat(Math.ceil(length / ALNUM.length)).slice(0, length);
}

/** One synthetic fixture per provider family, keyed by pattern label. */
const FIXTURES: Record<string, string> = {
  "AWS Access Key": "AKIAABCDEFGHIJKLMNOP",
  "GitHub Token": `ghp_${filler(36)}`,
  "GitHub Fine-Grained PAT": `github_pat_${filler(22)}`,
  "GitLab Token": `glpat-${filler(20)}`,
  "Stripe Secret Key": `sk_live_${filler(24)}`,
  "Stripe Restricted Key": `rk_live_${filler(24)}`,
  "Slack Bot Token": `xoxb-1234567890-1234567890-${filler(24)}`,
  "Slack User Token": `xoxp-1234567890-1234567890-1234567890-${"0123456789abcdef".repeat(2)}`,
  "Slack App Token": "xapp-1-abc123-4567-defghij890",
  "Telegram Bot Token": `123456789:${filler(35)}`,
  "Anthropic API Key": `sk-ant-${filler(80)}`,
  "OpenAI API Key": `sk-${filler(20)}T3BlbkFJ${filler(20)}`,
  "OpenAI Project Key": `sk-proj-${filler(40)}`,
  "Google API Key": `AIza${filler(35)}`,
  "Google OAuth Client Secret": `GOCSPX-${filler(28)}`,
  "Twilio API Key": `SK${"0123456789abcdef".repeat(2)}`,
  "SendGrid API Key": `SG.${filler(22)}.${filler(43)}`,
  "Mailgun API Key": `key-${filler(32)}`,
  "npm Token": `npm_${filler(36)}`,
  "PyPI API Token": `pypi-${filler(50)}`,
  "Private Key": "-----BEGIN OPENSSH PRIVATE KEY-----",
  "Linear API Key": `lin_api_${filler(32)}`,
  "Notion Integration Token": `ntn_${filler(40)}`,
  "OpenRouter API Key": `sk-or-v1-${filler(40)}`,
  "Vercel AI Gateway API Key": `vck_${filler(24)}`,
  "Fireworks API Key": `fw_${filler(32)}`,
  "Perplexity API Key": `pplx-${filler(40)}`,
  "Tavily API Key": `tvly-${filler(20)}`,
  "Firecrawl API Key": `fc-${filler(20)}`,
};

describe("subpath export", () => {
  test("@vellumai/service-contracts/secret-detection resolves to this module", () => {
    expect(subpathExport.PREFIX_PATTERNS).toBe(PREFIX_PATTERNS);
    expect(subpathExport.detectSecretsInText).toBe(detectSecretsInText);
  });
});

describe("PREFIX_PATTERNS", () => {
  test("every pattern has a fixture", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(
      PREFIX_PATTERNS.map((p) => p.label).sort(),
    );
  });

  test("pattern labels are unique", () => {
    const labels = PREFIX_PATTERNS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // Label-uniqueness invariant: each fixture matches exactly one pattern, so
  // a detected value always maps to an unambiguous label.
  for (const [label, fixture] of Object.entries(FIXTURES)) {
    test(`${label} fixture matches exactly that pattern`, () => {
      expect(matchingLabels(fixture)).toEqual([label]);
    });
  }

  test("does not match a short vck_ string", () => {
    expect(matchingLabels("vck_abc")).toEqual([]);
  });
});

describe("detectSecretsInText — prefix patterns", () => {
  for (const [label, fixture] of Object.entries(FIXTURES)) {
    test(`detects a ${label} with the right label and span`, () => {
      const text = `my key is ${fixture} thanks`;
      const start = text.indexOf(fixture);
      expect(detectSecretsInText(text)).toEqual([
        {
          label,
          value: fixture,
          start,
          end: start + fixture.length,
          wholeMessage: false,
        },
      ]);
    });
  }

  test("does not mutate the shared pattern objects' lastIndex", () => {
    detectSecretsInText(`ghp_${filler(36)}`);
    for (const p of PREFIX_PATTERNS) {
      expect(p.regex.lastIndex).toBe(0);
    }
  });
});

describe("detectSecretsInText — placeholder suppression", () => {
  test("known placeholder text returns no matches", () => {
    expect(detectSecretsInText("your-api-key-here")).toEqual([]);
    expect(detectSecretsInText("sk-xxxxxxxxxxxxxxxxxxxxxxxx")).toEqual([]);
  });

  test("placeholder-prefixed token-shaped message is suppressed", () => {
    expect(detectSecretsInText(`fake_key_${filler(20)}`)).toEqual([]);
    expect(detectSecretsInText(`test_api_${filler(16)}`)).toEqual([]);
    expect(detectSecretsInText(`dummy-token-${filler(16)}`)).toEqual([]);
  });

  test("token-shaped message with a placeholder tail is suppressed", () => {
    // TOKEN_SHAPE matches with tail "replace_with_your_key", which is a
    // known placeholder.
    expect(detectSecretsInText("acme_key_replace_with_your_key")).toEqual([]);
  });

  test("placeholder pre-context suppresses a prefix match (fake_ghp_...)", () => {
    // The GitHub regex matches starting at `ghp_`, so the `fake_` marker
    // sits in the pre-context window rather than the matched value.
    expect(detectSecretsInText(`fake_${"ghp_" + filler(36)}`)).toEqual([]);
    expect(
      detectSecretsInText(`docs use example_ghp_${filler(36)} as a stand-in`),
    ).toEqual([]);
  });

  test("repeated-character variable portion suppresses a prefix match", () => {
    // AKIA followed by 16 repeated placeholder characters.
    expect(detectSecretsInText("AKIAXXXXXXXXXXXXXXXX")).toEqual([]);
    expect(detectSecretsInText(`set AWS_KEY=AKIA${"X".repeat(16)}`)).toEqual(
      [],
    );
  });

  test("the same tokens without placeholder context still match", () => {
    const github = `ghp_${filler(36)}`;
    expect(detectSecretsInText(github).map((m) => m.label)).toEqual([
      "GitHub Token",
    ]);
    expect(
      detectSecretsInText("AKIAABCDEFGHIJKLMNOP").map((m) => m.label),
    ).toEqual(["AWS Access Key"]);
  });

  test("token-shaped message with a repeated-character tail is suppressed", () => {
    expect(detectSecretsInText(`my_key_${"x".repeat(16)}`)).toEqual([]);
  });
});

describe("detectSecretsInText — whole-message token shape", () => {
  test("a whole-message token-shaped value is detected", () => {
    const token = `virlo_tkn_${filler(20)}`;
    expect(TOKEN_SHAPE.test(token)).toBe(true);
    expect(detectSecretsInText(token)).toEqual([
      {
        label: TOKEN_SHAPE_LABEL,
        value: token,
        start: 0,
        end: token.length,
        wholeMessage: true,
      },
    ]);
  });

  test("surrounding whitespace is trimmed and the span covers the token", () => {
    const token = `acme_secret_${filler(18)}`;
    expect(detectSecretsInText(`  ${token} \n`)).toEqual([
      {
        label: TOKEN_SHAPE_LABEL,
        value: token,
        start: 2,
        end: 2 + token.length,
        wholeMessage: true,
      },
    ]);
  });

  test("a normal sentence returns no matches", () => {
    expect(
      detectSecretsInText("can you review my pull request today?"),
    ).toEqual([]);
    expect(detectSecretsInText("")).toEqual([]);
  });

  test("token shape is not applied when a prefix pattern already matched", () => {
    const key = `glpat-${filler(20)}`;
    const results = detectSecretsInText(key);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("GitLab Token");
  });

  test("a token-shaped value over the max length is not matched", () => {
    // Same shape as a valid token but a tail longer than the shared max — the
    // daemon ingress caps the whole-message heuristic here, so the client must
    // too or a >512-char paste would warn client-side yet pass server-side.
    const tail = filler(TOKEN_SHAPE_MAX_LENGTH + 1);
    const token = `virlo_tkn_${tail}`;
    expect(token.length).toBeGreaterThan(TOKEN_SHAPE_MAX_LENGTH);
    expect(TOKEN_SHAPE.test(token)).toBe(true);
    expect(detectSecretsInText(token)).toEqual([]);
  });

  test("a token-shaped value exactly at the max length is still matched", () => {
    const prefix = "virlo_tkn_";
    const token = `${prefix}${filler(TOKEN_SHAPE_MAX_LENGTH - prefix.length)}`;
    expect(token.length).toBe(TOKEN_SHAPE_MAX_LENGTH);
    const results = detectSecretsInText(token);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe(TOKEN_SHAPE_LABEL);
  });
});

describe("REDACTION_PREFIX_PATTERNS — bounded whole-block private key", () => {
  const FAKE_PEM_BODY =
    "MIIFAKEfakefakefakefakefakefakefakefakefake\n" +
    "FAKEfakefakefakefakefakefakefakefakefake==";
  const FULL_PEM_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

  function redactionPrivateKeyRegex(): RegExp {
    const entry = REDACTION_PREFIX_PATTERNS.find(
      (p) => p.label === "Private Key",
    );
    expect(entry).toBeDefined();
    return new RegExp(entry!.regex.source, "g");
  }

  test("the redaction private-key entry is the bounded whole-block matcher", () => {
    const entry = REDACTION_PREFIX_PATTERNS.find(
      (p) => p.label === "Private Key",
    );
    expect(entry!.regex.source).toBe(PRIVATE_KEY_REDACTION_REGEX.source);
  });

  test("the redaction variant matches the WHOLE block, not just the header", () => {
    const regex = redactionPrivateKeyRegex();
    const match = regex.exec(FULL_PEM_BLOCK);
    expect(match).not.toBeNull();
    // The full header→body→footer span, so an in-place replace removes the
    // key body and footer, not only the BEGIN line.
    expect(match![0]).toBe(FULL_PEM_BLOCK);
  });

  test("an in-place replace with the redaction regex leaves no body or footer", () => {
    const regex = redactionPrivateKeyRegex();
    const text = `before\n${FULL_PEM_BLOCK}\nafter`;
    const redacted = text.replace(regex, "[REDACTED]");
    expect(redacted).toBe("before\n[REDACTED]\nafter");
    // The base64 body and the END footer are gone.
    expect(redacted).not.toContain("MIIFAKE");
    expect(redacted).not.toContain("-----END");
    expect(redacted).not.toContain("-----BEGIN");
  });

  test("a footerless key still redacts header-only (truncated-key fallback)", () => {
    const regex = redactionPrivateKeyRegex();
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}`;
    const match = regex.exec(text);
    expect(match).not.toBeNull();
    // No END within the bound → optional footer group fails → header-only
    // match, preserving the detection-fires guarantee.
    expect(match![0]).toBe("-----BEGIN RSA PRIVATE KEY-----");
  });

  test("a body longer than the bound falls back to header-only, not a hang", () => {
    const regex = redactionPrivateKeyRegex();
    // Footer sits just past the body bound, so the whole-block branch can't
    // reach it and the match degrades to the header (fail-open on redaction:
    // an unbounded key is not a realistic PEM).
    const overlongBody = "a".repeat(PEM_REDACTION_MAX_BODY_LENGTH + 100);
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${overlongBody}\n-----END RSA PRIVATE KEY-----`;
    const match = regex.exec(text);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("-----BEGIN RSA PRIVATE KEY-----");
  });

  test("many footerless BEGIN headers redact fast (bounded, no O(n²) hang)", () => {
    const regex = redactionPrivateKeyRegex();
    // A pathological paste: thousands of footerless headers, each followed by
    // filler that an unbounded matcher would rescan hunting for a footer. The
    // body bound caps each rescan, so the whole sweep stays linear.
    const chunk = `-----BEGIN RSA PRIVATE KEY-----\n${filler(200)}\n`;
    const text = chunk.repeat(5000);
    const startedAt = Date.now();
    const redacted = text.replace(regex, "[REDACTED]");
    const elapsedMs = Date.now() - startedAt;
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("-----BEGIN");
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("every non-private-key pattern is shared verbatim with PREFIX_PATTERNS", () => {
    for (let i = 0; i < PREFIX_PATTERNS.length; i++) {
      if (PREFIX_PATTERNS[i]!.label === "Private Key") {
        continue;
      }
      expect(REDACTION_PREFIX_PATTERNS[i]).toBe(PREFIX_PATTERNS[i]);
    }
  });

  test("detectSecretsInText still captures the whole block (P1 stays fixed)", () => {
    const results = detectSecretsInText(FULL_PEM_BLOCK);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("Private Key");
    expect(results[0]!.value).toBe(FULL_PEM_BLOCK);
  });
});

describe("detectSecretsInText — PEM private-key blocks", () => {
  // Clearly fake PEM material — never a real key.
  const FAKE_PEM_BODY =
    "MIIFAKEfakefakefakefakefakefakefakefakefake\n" +
    "FAKEfakefakefakefakefakefakefakefakefake==";
  const FULL_PEM_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

  test("a complete PEM block is one match spanning header through footer", () => {
    const text = `here is my key\n${FULL_PEM_BLOCK}\nplease use it`;
    const start = text.indexOf(FULL_PEM_BLOCK);
    expect(detectSecretsInText(text)).toEqual([
      {
        label: "Private Key",
        value: FULL_PEM_BLOCK,
        start,
        end: start + FULL_PEM_BLOCK.length,
        wholeMessage: false,
      },
    ]);
  });

  test("a PGP private-key block with the BLOCK suffix is captured whole", () => {
    const block = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${FAKE_PEM_BODY}\n-----END PGP PRIVATE KEY BLOCK-----`;
    const results = detectSecretsInText(block);
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe(block);
  });

  test("a header with a body but no END footer still fires — header-only span", () => {
    // Truncated / partially pasted key: detection must not regress, the
    // daemon ingress relies on the header alone to block.
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_PEM_BODY}`;
    const results = detectSecretsInText(text);
    expect(results).toEqual([
      {
        label: "Private Key",
        value: "-----BEGIN RSA PRIVATE KEY-----",
        start: 0,
        end: "-----BEGIN RSA PRIVATE KEY-----".length,
        wholeMessage: false,
      },
    ]);
    expect(isCompletePrivateKeyBlock(results[0]!.value)).toBe(false);
  });

  test("adjacent complete blocks match separately, not as one giant span", () => {
    const text = `${FULL_PEM_BLOCK}\n\n${FULL_PEM_BLOCK}`;
    const results = detectSecretsInText(text);
    expect(results).toHaveLength(2);
    expect(results[0]!.value).toBe(FULL_PEM_BLOCK);
    expect(results[1]!.value).toBe(FULL_PEM_BLOCK);
    expect(results[1]!.start).toBeGreaterThanOrEqual(results[0]!.end);
  });

  test("a footerless header never swallows a later complete block", () => {
    // The body is tempered — it cannot cross another BEGIN header — so the
    // truncated first key matches header-only and the second key matches
    // as its own complete block.
    const text = `-----BEGIN EC PRIVATE KEY-----\ntruncated\n\n${FULL_PEM_BLOCK}`;
    const results = detectSecretsInText(text);
    expect(results.map((r) => r.value)).toEqual([
      "-----BEGIN EC PRIVATE KEY-----",
      FULL_PEM_BLOCK,
    ]);
  });

  test("a token-lookalike run inside the block body loses to the block", () => {
    // Base64 can legally contain an AKIA + 16-uppercase run; the Private
    // Key pattern is first in PREFIX_PATTERNS so the whole-block span wins
    // the overlap dedupe instead of being fragmented by the AWS pattern.
    const block = `-----BEGIN RSA PRIVATE KEY-----\nAKIAABCDEFGHIJKLMNOP\n${FAKE_PEM_BODY}\n-----END RSA PRIVATE KEY-----`;
    const results = detectSecretsInText(block);
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("Private Key");
    expect(results[0]!.value).toBe(block);
  });
});

describe("isCompletePrivateKeyBlock", () => {
  test("true for a value ending at the END footer", () => {
    expect(
      isCompletePrivateKeyBlock(
        "-----BEGIN OPENSSH PRIVATE KEY-----\nMIIFAKEfake==\n-----END OPENSSH PRIVATE KEY-----",
      ),
    ).toBe(true);
  });

  test("false for a header-only match and for non-PEM values", () => {
    expect(
      isCompletePrivateKeyBlock("-----BEGIN OPENSSH PRIVATE KEY-----"),
    ).toBe(false);
    expect(isCompletePrivateKeyBlock(`ghp_${filler(36)}`)).toBe(false);
  });
});

describe("detectSecretsInText — multiple and overlapping matches", () => {
  test("multiple secrets yield sorted, non-overlapping matches", () => {
    const aws = "AKIAABCDEFGHIJKLMNOP";
    const github = `ghp_${filler(36)}`;
    // GitHub appears before AWS in the text but after it in pattern order.
    const text = `first ${github} then ${aws} done`;
    const results = detectSecretsInText(text);
    expect(results.map((r) => r.label)).toEqual([
      "GitHub Token",
      "AWS Access Key",
    ]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.start).toBeGreaterThanOrEqual(results[i - 1]!.end);
    }
  });

  test("overlapping spans keep the first pattern in list order", () => {
    // The GitHub token's tail embeds an `npm_…` run; GitHub Token precedes
    // npm Token in PREFIX_PATTERNS, so only the GitHub match survives.
    const value = `ghp_npm_${filler(36)}`;
    const results = detectSecretsInText(value);
    expect(results.map((r) => r.label)).toEqual(["GitHub Token"]);
  });
});
