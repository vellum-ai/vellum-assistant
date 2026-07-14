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
  buildLiveRevealGuardEntries,
  collectRevealRefsFromCommand,
  drainSentinelGuardedText,
  redactSecretsForChat,
  resolveRevealCandidates,
  swapLiveRevealValues,
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

  test("duplicate plaintext across two identities degrades to the plain sentinel", () => {
    // A byte match proves the value, not the vault identity: when two
    // revealed credentials share the same plaintext, minting either chip
    // would mislabel the span (and reveal the wrong value later if that
    // credential rotates). The ambiguity must fail safe.
    const out = redactSecretsForChat(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`, [
      {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
      {
        service: "litellm",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
    ]);
    expect(out).toBe("key: \u3014redacted:OpenAI Project Key\u3015");
    expect(out).not.toContain(":openai:");
    expect(out).not.toContain(":litellm:");
  });

  test("duplicate candidate entries that agree on identity stay revealable", () => {
    // The same reveal recorded twice (repeated command in one turn) is not
    // ambiguous — only distinct identities sharing a value degrade.
    const out = redactSecretsForChat(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`, [
      {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
      {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
    ]);
    expect(out).toBe(
      "key: \u3014redacted:OpenAI Project Key:openai:api_key\u3015",
    );
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
    expect(out.consumedRaw).toBe("nothing suspicious here");
    expect(out.bufferedRemainder).toBe("");
  });
});

describe("live reveal swap (stream plaintext hold-back)", () => {
  const CANDIDATE = {
    service: "openai",
    field: "api_key",
    value: SYNTHETIC_OPENAI_PROJECT_KEY,
  };
  const ENTRIES = buildLiveRevealGuardEntries([CANDIDATE]);
  const SENTINEL = redactSecretsForChat(SYNTHETIC_OPENAI_PROJECT_KEY, [
    CANDIDATE,
  ]);

  test("buildLiveRevealGuardEntries pairs a detectable value with its enriched sentinel", () => {
    expect(ENTRIES).toEqual([
      { value: SYNTHETIC_OPENAI_PROJECT_KEY, replacement: SENTINEL },
    ]);
    expect(SENTINEL).toContain(":openai:api_key\u3015");
  });

  test("buildLiveRevealGuardEntries drops a value the scanner does not detect", () => {
    expect(
      buildLiveRevealGuardEntries([
        { service: "svc", field: "f", value: "not a real secret shape" },
      ]),
    ).toEqual([]);
  });

  test("buildLiveRevealGuardEntries degrades a duplicate plaintext to the plain sentinel, matching persist", () => {
    // Two identities sharing one value: the persist seam degrades that span
    // to the plain type-only sentinel, so the live swap must emit the same
    // bytes — one deduped entry whose replacement carries no identity.
    const entries = buildLiveRevealGuardEntries([
      {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
      {
        service: "litellm",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
    ]);
    expect(entries).toEqual([
      {
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
        replacement: "\u3014redacted:OpenAI Project Key\u3015",
      },
    ]);
  });

  test("swaps a complete echoed value within one chunk", () => {
    const raw = `Here it is: ${SYNTHETIC_OPENAI_PROJECT_KEY} — rotate it.`;
    const out = drainSentinelGuardedText(raw, ENTRIES);
    expect(out.emitText).toBe(`Here it is: ${SENTINEL} — rotate it.`);
    expect(out.emitText).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
    expect(out.consumedRaw).toBe(raw);
    expect(out.bufferedRemainder).toBe("");
  });

  test("holds back a value split across chunks, then swaps on completion", () => {
    const head = SYNTHETIC_OPENAI_PROJECT_KEY.slice(0, 12);
    const tail = SYNTHETIC_OPENAI_PROJECT_KEY.slice(12);
    const first = drainSentinelGuardedText(`token: ${head}`, ENTRIES);
    expect(first.emitText).toBe("token: ");
    expect(first.bufferedRemainder).toBe(head);
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + tail + " end",
      ENTRIES,
    );
    expect(second.emitText).toBe(`${SENTINEL} end`);
    expect(second.emitText).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
    expect(second.bufferedRemainder).toBe("");
  });

  test("releases a held value prefix that never completes", () => {
    const head = SYNTHETIC_OPENAI_PROJECT_KEY.slice(0, 12);
    const first = drainSentinelGuardedText(`prefix ${head}`, ENTRIES);
    expect(first.bufferedRemainder).toBe(head);
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + "-not-the-secret",
      ENTRIES,
    );
    expect(second.emitText).toBe(`${head}-not-the-secret`);
    expect(second.bufferedRemainder).toBe("");
  });

  test("consumedRaw carries the plaintext for persist-side re-redaction", () => {
    const raw = `value ${SYNTHETIC_OPENAI_PROJECT_KEY}.`;
    const out = drainSentinelGuardedText(raw, ENTRIES);
    // The mirror path re-redacts consumedRaw at persist; verify the round
    // trip lands on the same sentinel the live stream emitted.
    expect(redactSecretsForChat(out.consumedRaw, [CANDIDATE])).toBe(
      out.emitText,
    );
  });

  test("swaps a self-overlapping value chunked at the overlap boundary", () => {
    // A value whose proper prefix is also its suffix (`abcabc`), chunked
    // exactly at the overlap (`abc` + `abc`). The hold must consume the
    // complete occurrence instead of re-holding the trailing repeat —
    // otherwise the first half is emitted as raw plaintext and the swap
    // never sees the full value.
    const entries = [{ value: "abcabc", replacement: "[SWAPPED]" }];
    const first = drainSentinelGuardedText("abc", entries);
    expect(first.emitText).toBe("");
    expect(first.bufferedRemainder).toBe("abc");
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + "abc",
      entries,
    );
    expect(second.emitText).toBe("[SWAPPED]");
    expect(second.consumedRaw).toBe("abcabc");
    expect(second.bufferedRemainder).toBe("");
  });

  test("holds only the partial repeat after a complete self-overlapping occurrence", () => {
    const entries = [{ value: "abcabc", replacement: "[SWAPPED]" }];
    const out = drainSentinelGuardedText("abcabcabc", entries);
    expect(out.emitText).toBe("[SWAPPED]");
    expect(out.consumedRaw).toBe("abcabc");
    expect(out.bufferedRemainder).toBe("abc");
  });

  test("does not split a completed value to hold another entry's prefix", () => {
    // Round-11 case: candidate A ends with a proper prefix of candidate B
    // (`…-sk` / `sk-…`). A chunk ending exactly after a complete A must
    // swap A whole — a per-entry hold computed over the raw buffer would
    // hold B's `sk` prefix out of A's tail, splitting A so the swap
    // misses it and `xx-` leaks raw over the live stream.
    const entries = [
      { value: "xx-sk", replacement: "[A]" },
      { value: "sk-yyyy", replacement: "[B]" },
    ];
    const out = drainSentinelGuardedText("token xx-sk", entries);
    expect(out.emitText).toBe("token [A]");
    expect(out.consumedRaw).toBe("token xx-sk");
    expect(out.bufferedRemainder).toBe("");
  });

  test("still holds another entry's prefix when it follows a completed value", () => {
    // Bytes AFTER the consumed occurrence are fair game: `sk` following a
    // complete A is genuinely ambiguous (B may be starting) and is held,
    // while A itself swaps whole.
    const entries = [
      { value: "xx-sk", replacement: "[A]" },
      { value: "sk-yyyy", replacement: "[B]" },
    ];
    const first = drainSentinelGuardedText("token xx-sk sk", entries);
    expect(first.emitText).toBe("token [A] ");
    expect(first.consumedRaw).toBe("token xx-sk ");
    expect(first.bufferedRemainder).toBe("sk");
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + "-yyyy done",
      entries,
    );
    expect(second.emitText).toBe("[B] done");
    expect(second.consumedRaw).toBe("sk-yyyy done");
    expect(second.bufferedRemainder).toBe("");
  });

  test("hold-back skips occurrences with the swap's greedy left-to-right semantics", () => {
    // `abab` with value `aba`: split/join consumes the occurrence at 0 and
    // does NOT match the overlapping occurrence at 2, so the guard must not
    // hold the trailing `b` (not a prefix) — live emit and persist-time
    // redaction stay byte-identical.
    const entries = [{ value: "aba", replacement: "[X]" }];
    const out = drainSentinelGuardedText("abab", entries);
    expect(out.emitText).toBe("[X]b");
    expect(out.consumedRaw).toBe("abab");
    expect(out.bufferedRemainder).toBe("");
  });

  test("swaps the longest matching value when one candidate prefixes another", () => {
    // Insertion order must not matter: with the shorter entry first, the
    // longer echoed value would otherwise get the shorter chip plus its
    // unmatched suffix emitted raw — inconsistent with persist-time
    // redaction, which redacts the whole longer span.
    const entries = [
      { value: "sk-abc", replacement: "[SHORT]" },
      { value: "sk-abcdef", replacement: "[LONG]" },
    ];
    expect(swapLiveRevealValues("key: sk-abcdef end", entries)).toBe(
      "key: [LONG] end",
    );
    expect(swapLiveRevealValues("a sk-abc b sk-abcdef c", entries)).toBe(
      "a [SHORT] b [LONG] c",
    );
  });

  test("swapLiveRevealValues replaces multiple occurrences", () => {
    const text = `a ${SYNTHETIC_OPENAI_PROJECT_KEY} b ${SYNTHETIC_OPENAI_PROJECT_KEY} c`;
    expect(swapLiveRevealValues(text, ENTRIES)).toBe(
      `a ${SENTINEL} b ${SENTINEL} c`,
    );
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
