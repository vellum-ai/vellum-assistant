import { describe, expect, test } from "bun:test";

// Self-referencing package import — proves the `./secret-detection` subpath
// export resolves for consumers.
import * as subpathExport from "@vellumai/service-contracts/secret-detection";

import {
  detectSecretsInText,
  PREFIX_PATTERNS,
  TOKEN_SHAPE,
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
});

describe("detectSecretsInText — whole-message token shape", () => {
  test("a whole-message token-shaped value is detected", () => {
    const token = `virlo_tkn_${filler(20)}`;
    expect(TOKEN_SHAPE.test(token)).toBe(true);
    expect(detectSecretsInText(token)).toEqual([
      {
        label: "Token-shaped message",
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
        label: "Token-shaped message",
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
