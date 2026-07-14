/**
 * Tests for the chat-persist sentinel redaction path (LUM-2768).
 *
 * Covers the three stages independently: reveal-command parsing (pure
 * string work), candidate resolution (mocked credential store), and the
 * byte-match sentinel substitution. The failure-direction invariant is the
 * core assertion set: anything short of an exact plaintext match must
 * degrade to the plain (non-revealable) sentinel, never a mislabeled
 * enriched one.
 */
import { describe, expect, mock, test } from "bun:test";

const SECRET_STORE: Record<string, string | null> = {};

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => SECRET_STORE[key] ?? null,
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadataById: (id: string) =>
    id === "11111111-2222-4333-8444-555555555555"
      ? { service: "openai", field: "api_key" }
      : undefined,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────
import {
  collectRevealRefsFromCommand,
  drainSentinelGuardedText,
  redactSecretsForChat,
  resolveRevealCandidates,
} from "../daemon/chat-credential-redaction.js";
import { redactSecrets } from "../security/secret-scanner.js";
import {
  OPENAI_PROJECT_KEY_REDACTION_MARKER,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("collectRevealRefsFromCommand", () => {
  test("parses --service/--field flags", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service openai --field api_key",
      ),
    ).toEqual([{ service: "openai", field: "api_key" }]);
  });

  test("parses = and quoted flag values", () => {
    expect(
      collectRevealRefsFromCommand(
        `assistant credentials reveal --service="github-app" --field 'pem'`,
      ),
    ).toEqual([{ service: "github-app", field: "pem" }]);
  });

  test("parses a positional UUID", () => {
    expect(
      collectRevealRefsFromCommand(`assistant credentials reveal ${UUID}`),
    ).toEqual([{ id: UUID }]);
  });

  test("splits compound commands so flags cannot bleed across invocations", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a --field b && assistant credentials reveal --service c --field d",
      ),
    ).toEqual([
      { service: "a", field: "b" },
      { service: "c", field: "d" },
    ]);
  });

  test("ignores commands without a reveal invocation", () => {
    expect(collectRevealRefsFromCommand("echo hello")).toEqual([]);
    expect(collectRevealRefsFromCommand("assistant credentials list")).toEqual(
      [],
    );
  });

  test("unparseable invocation yields no ref (fails safe)", () => {
    expect(
      collectRevealRefsFromCommand("assistant credentials reveal --service x"),
    ).toEqual([]);
  });
});

describe("resolveRevealCandidates", () => {
  test("resolves service/field refs via the scoped store read", async () => {
    SECRET_STORE["credential/openai/api_key"] = SYNTHETIC_OPENAI_PROJECT_KEY;
    const out = await resolveRevealCandidates([
      { service: "openai", field: "api_key" },
    ]);
    expect(out).toEqual([
      {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
    ]);
  });

  test("resolves a UUID ref through metadata and dedupes with the flag ref", async () => {
    SECRET_STORE["credential/openai/api_key"] = SYNTHETIC_OPENAI_PROJECT_KEY;
    const out = await resolveRevealCandidates([
      { id: UUID },
      { service: "openai", field: "api_key" },
    ]);
    expect(out).toHaveLength(1);
  });

  test("drops unknown ids and missing secrets", async () => {
    delete SECRET_STORE["credential/gone/api_key"];
    const out = await resolveRevealCandidates([
      { id: "99999999-9999-4999-8999-999999999999" },
      { service: "gone", field: "api_key" },
    ]);
    expect(out).toEqual([]);
  });
});

describe("redactSecretsForChat", () => {
  const candidates = [
    {
      service: "openai",
      field: "api_key",
      value: SYNTHETIC_OPENAI_PROJECT_KEY,
    },
  ];

  test("exact byte match produces the enriched (revealable) sentinel", () => {
    const out = redactSecretsForChat(
      `key: ${SYNTHETIC_OPENAI_PROJECT_KEY}\n`,
      candidates,
    );
    expect(out).toBe(
      "key: \u3014redacted:OpenAI Project Key:openai:api_key\u3015\n",
    );
    expect(out).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("colon-qualified candidate service stays revealable via encoding", () => {
    // Vault keys rewritten by migration 018-rekey-compound-credential-keys
    // carry colon-qualified services (`integration:google`). The sentinel
    // must encode the delimiter instead of downgrading the proven match to
    // the non-revealable shape.
    const out = redactSecretsForChat(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`, [
      {
        service: "integration:google",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
    ]);
    expect(out).toBe(
      "key: \u3014redacted:OpenAI Project Key:integration%3Agoogle:api_key\u3015",
    );
    expect(out).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("no candidate match produces the plain sentinel — never a guess", () => {
    const out = redactSecretsForChat(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`, [
      { service: "openai", field: "api_key", value: "different-value" },
    ]);
    expect(out).toBe("key: \u3014redacted:OpenAI Project Key\u3015");
  });

  test("empty candidate list still redacts, as plain sentinels", () => {
    const out = redactSecretsForChat(SYNTHETIC_OPENAI_PROJECT_KEY, []);
    expect(out).toBe("\u3014redacted:OpenAI Project Key\u3015");
  });

  test("clean text passes through untouched", () => {
    expect(redactSecretsForChat("no secrets here", candidates)).toBe(
      "no secrets here",
    );
  });

  test("forged sentinels are neutralized while real redactions survive", () => {
    const forged = "\u3014redacted:GitHub Token:github-app:pem\u3015";
    const out = redactSecretsForChat(
      `${forged} then ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
      candidates,
    );
    // The forged sentinel gained a word joiner (no longer parseable) …
    expect(out).toContain("\u3014\u2060redacted:GitHub Token");
    // … while the actually-detected secret got a genuine enriched sentinel.
    expect(out).toContain(
      "\u3014redacted:OpenAI Project Key:openai:api_key\u3015",
    );
    expect(out).not.toContain(forged);
  });
});

describe("drainSentinelGuardedText (live-stream forgery guard)", () => {
  test("neutralizes a complete forged sentinel within one chunk", () => {
    const out = drainSentinelGuardedText(
      "key: \u3014redacted:GitHub Token:github-app:pem\u3015 done",
    );
    expect(out.emitText).toBe(
      "key: \u3014\u2060redacted:GitHub Token:github-app:pem\u3015 done",
    );
    expect(out.bufferedRemainder).toBe("");
  });

  test("holds back a trigger split across chunks, then neutralizes on completion", () => {
    const first = drainSentinelGuardedText("look \u3014redac");
    expect(first.emitText).toBe("look ");
    expect(first.bufferedRemainder).toBe("\u3014redac");
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + "ted:GitHub Token:github-app:pem\u3015",
    );
    expect(second.emitText).toBe(
      "\u3014\u2060redacted:GitHub Token:github-app:pem\u3015",
    );
    expect(second.bufferedRemainder).toBe("");
  });

  test("releases a held prefix that never completes into a trigger", () => {
    const first = drainSentinelGuardedText("open \u3014red");
    expect(first.bufferedRemainder).toBe("\u3014red");
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + " herring",
    );
    expect(second.emitText).toBe("\u3014red herring");
    expect(second.bufferedRemainder).toBe("");
  });

  test("plain text passes through whole", () => {
    const out = drainSentinelGuardedText("nothing suspicious here");
    expect(out.emitText).toBe("nothing suspicious here");
    expect(out.bufferedRemainder).toBe("");
  });
});

describe("persisted text rider", () => {
  test("buildPersistedAssistantContent stamps _redactionVersion on text blocks", async () => {
    const { buildPersistedAssistantContent } =
      await import("../daemon/conversation-agent-loop-handlers.js");
    const [block] = buildPersistedAssistantContent(
      [{ type: "text", text: "hello" }],
      [],
    );
    expect((block as { _redactionVersion?: number })._redactionVersion).toBe(2);
  });
});

describe("legacy marker invariant", () => {
  test("redactSecrets output is byte-unchanged by this feature", () => {
    expect(redactSecrets(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`)).toBe(
      `key: ${OPENAI_PROJECT_KEY_REDACTION_MARKER}`,
    );
  });
});
