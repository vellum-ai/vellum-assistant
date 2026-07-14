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
  drainCandidateGuardedChunk,
  drainSentinelGuardedText,
  filterRefsByRevealProof,
  redactCandidateValuesLegacy,
  redactSecretsForChat,
  resolveProvenRevealCandidates,
  resolveRefIdentities,
  resolveRevealCandidates,
  swapLiveRevealValues,
} from "../daemon/chat-credential-redaction.js";
import {
  _resetRevealSuccessRegistryForTest,
  recordRevealSuccess,
} from "../runtime/reveal-success-registry.js";
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

  test("splits on a single & background separator", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a --field b & assistant credentials reveal --service c --field d",
      ),
    ).toEqual([
      { service: "a", field: "b" },
      { service: "c", field: "d" },
    ]);
  });

  test("does not treat && as two single-& separators", () => {
    // The two-char operator must win at its position; a spurious empty split
    // between the ampersands would drop the second invocation's flags.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a --field b&&assistant credentials reveal --service c --field d",
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

  test("keeps both values when the same credential was rotated and re-revealed", async () => {
    // reveal v1 → `credentials set` → reveal v2 inside one turn: the route
    // served BOTH plaintexts to the tool's stdout, so both must survive as
    // candidates. Deduping on identity alone would drop one and let it
    // stream/persist raw whenever the scanner cannot classify it.
    const out = await resolveRevealCandidates([
      {
        service: "openai",
        field: "api_key",
        provenValue: "hunter2-rotated-alpha",
      },
      {
        service: "openai",
        field: "api_key",
        provenValue: "hunter2-rotated-beta",
      },
    ]);
    expect(out).toEqual([
      { service: "openai", field: "api_key", value: "hunter2-rotated-alpha" },
      { service: "openai", field: "api_key", value: "hunter2-rotated-beta" },
    ]);
  });

  test("still dedupes proven refs that agree on identity AND value", async () => {
    const out = await resolveRevealCandidates([
      { service: "openai", field: "api_key", provenValue: "hunter2-same" },
      { service: "openai", field: "api_key", provenValue: "hunter2-same" },
    ]);
    expect(out).toHaveLength(1);
  });

  test("a value with JSON-escapable bytes also yields its escaped encoding", async () => {
    // `credentials reveal --json` prints the value through JSON.stringify,
    // so newlines/quotes/backslashes reach stdout ESCAPED — a representation
    // the raw exact-match list can never find. Both encodings must be
    // candidates.
    const out = await resolveRevealCandidates([
      { service: "github-app", field: "pem", provenValue: "line1\nline2" },
    ]);
    expect(out).toEqual([
      { service: "github-app", field: "pem", value: "line1\nline2" },
      { service: "github-app", field: "pem", value: "line1\\nline2" },
    ]);
  });

  test("a value with no escapable bytes yields a single candidate", async () => {
    const out = await resolveRevealCandidates([
      { service: "svc", field: "f", provenValue: "hunter2-plain" },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("resolveRefIdentities (eager staging lookup)", () => {
  test("resolves a UUID ref to service/field and keeps the id", () => {
    expect(resolveRefIdentities([{ id: UUID }])).toEqual([
      { id: UUID, service: "openai", field: "api_key" },
    ]);
  });

  test("passes an unknown id through for the proof-time fallback", () => {
    const ref = { id: "99999999-9999-4999-8999-999999999999" };
    expect(resolveRefIdentities([ref])).toEqual([ref]);
  });
});

describe("filterRefsByRevealProof identity handling", () => {
  test("a pre-resolved id ref stays proven after its metadata disappears", () => {
    // Staging resolved the id to service/field while the metadata still
    // existed; the credential was then removed before the tool result. The
    // carried identity must satisfy the proof — a metadata re-lookup would
    // fail and silently drop the ref for a value the tool already printed.
    _resetRevealSuccessRegistryForTest();
    recordRevealSuccess("gone-service", "api_key", "hunter2-removed");
    const proven = filterRefsByRevealProof(
      [
        {
          id: "99999999-9999-4999-8999-999999999999",
          service: "gone-service",
          field: "api_key",
        },
      ],
      0,
    );
    expect(proven).toEqual([
      {
        service: "gone-service",
        field: "api_key",
        provenValue: "hunter2-removed",
      },
    ]);
    _resetRevealSuccessRegistryForTest();
  });
});

describe("drainCandidateGuardedChunk (live tool output guard)", () => {
  const candidates = [{ service: "svc", field: "f", value: "hunter2-opaque" }];

  test("redacts a complete occurrence within one chunk", () => {
    const out = drainCandidateGuardedChunk(
      "value: hunter2-opaque\n",
      candidates,
    );
    expect(out.emitText).toBe('value: <redacted type="Credential" />\n');
    expect(out.bufferedRemainder).toBe("");
  });

  test("holds a trailing partial occurrence, then redacts on completion", () => {
    const first = drainCandidateGuardedChunk("out: hunter2-op", candidates);
    expect(first.emitText).toBe("out: ");
    expect(first.bufferedRemainder).toBe("hunter2-op");
    const second = drainCandidateGuardedChunk(
      first.bufferedRemainder + "aque done",
      candidates,
    );
    expect(second.emitText).toBe('<redacted type="Credential" /> done');
    expect(second.bufferedRemainder).toBe("");
  });

  test("passes clean chunks through whole", () => {
    const out = drainCandidateGuardedChunk("plain output\n", candidates);
    expect(out.emitText).toBe("plain output\n");
    expect(out.bufferedRemainder).toBe("");
  });

  test("resolveProvenRevealCandidates skips refs without a proven value", () => {
    expect(
      resolveProvenRevealCandidates([
        { service: "svc", field: "f" },
        { service: "svc", field: "f", provenValue: "hunter2-opaque" },
      ]),
    ).toEqual(candidates);
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

  test("a full PEM candidate is redacted whole, not just its header", () => {
    // The scanner's `Private Key` pattern matches ONLY the
    // `-----BEGIN … PRIVATE KEY-----` header, so a scanner-first pass would
    // replace the header and leave the base64 body raw — and the full-value
    // fallback would then miss because the intact value no longer exists.
    // Candidate protection must run before the scanner so the whole key
    // becomes one sentinel and no body bytes survive.
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q\n" +
      "uKUpRKfFLfRYC9AIKjbJTWit+CqvjfRasdf0123456789abcdefGHIJKLMNOPQR\n" +
      "-----END RSA PRIVATE KEY-----";
    const out = redactSecretsForChat(`here:\n${pem}\ndone`, [
      { service: "github-app", field: "pem", value: pem },
    ]);
    expect(out).not.toContain("MIIBOgIBAAJBAKj34GkxFhD90");
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).toBe(
      "here:\n\u3014redacted:Private Key:github-app:pem\u3015\ndone",
    );
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

  test("a candidate value equal to another's service name cannot corrupt its sentinel", () => {
    // The enriched sentinel embeds `service:field` text, so a second proven
    // candidate whose plaintext is literally that service name (`openai`)
    // would — under a sequential rewrite — match INSIDE the just-emitted
    // sentinel and nest markers. Swaps must only consume raw-text spans.
    const out = redactSecretsForChat(
      `key: ${SYNTHETIC_OPENAI_PROJECT_KEY} via openai`,
      [
        {
          service: "openai",
          field: "api_key",
          value: SYNTHETIC_OPENAI_PROJECT_KEY,
        },
        { service: "manual", field: "token", value: "openai" },
      ],
    );
    expect(out).toBe(
      "key: \u3014redacted:OpenAI Project Key:openai:api_key\u3015 via \u3014redacted:Credential:manual:token\u3015",
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

  test("buildLiveRevealGuardEntries covers a value the scanner cannot classify bare", () => {
    // Round-14 case: several scanner patterns only match WITH context
    // (`password=<value>` and friends), so a bare-undetectable candidate
    // must still get an entry — dropping it let the plaintext cross the
    // live stream raw while final persistence redacted the contextual
    // occurrence. The replacement falls back to a generic-typed enriched
    // sentinel built from the candidate identity.
    expect(
      buildLiveRevealGuardEntries([
        { service: "svc", field: "f", value: "not a real secret shape" },
      ]),
    ).toEqual([
      {
        value: "not a real secret shape",
        replacement: "\u3014redacted:Credential:svc:f\u3015",
      },
    ]);
  });

  test("persist redacts an unclassifiable candidate value via the exact-match fallback", () => {
    // Round-15 case: the live guard swaps a scanner-unclassifiable value,
    // so persistence MUST redact it too — otherwise the SSE transcript
    // hides the secret while the stored row keeps the raw plaintext and a
    // refresh or history fetch exposes it. The persisted bytes must equal
    // the streamed replacement exactly.
    const candidates = [
      { service: "svc", field: "f", value: "not a real secret shape" },
    ];
    const persisted = redactSecretsForChat(
      "your token is not a real secret shape — keep it safe",
      candidates,
    );
    expect(persisted).toBe(
      "your token is \u3014redacted:Credential:svc:f\u3015 — keep it safe",
    );
    expect(persisted).not.toContain("not a real secret shape");
    // Byte-identity with the live guard entry.
    const [entry] = buildLiveRevealGuardEntries(candidates);
    expect(entry!.replacement).toBe("\u3014redacted:Credential:svc:f\u3015");
  });

  test("redactCandidateValuesLegacy covers unclassifiable values on legacy-marker surfaces", () => {
    // Round-16 case: the reveal command's own stdout persists into the
    // tool_result row via the legacy `<redacted type/>` path (the tool
    // detail panel renders no chips). An opaque/manual value with no
    // scanner-recognizable shape must still be redacted there — the
    // stored tool result must not retain a value every other surface
    // hides.
    const candidates = [
      { service: "svc", field: "f", value: "hunter2-opaque" },
    ];
    expect(
      redactCandidateValuesLegacy("stdout: hunter2-opaque\n", candidates),
    ).toBe('stdout: <redacted type="Credential" />\n');
    // No candidates → byte-identical passthrough (legacy mode unchanged).
    expect(redactCandidateValuesLegacy("stdout: hunter2-opaque\n", [])).toBe(
      "stdout: hunter2-opaque\n",
    );
  });

  test("redactCandidateValuesLegacy redacts a full PEM candidate whole", () => {
    // Same PEM hazard on the legacy surface: the scanner recognizes only the
    // header, so candidate protection must run before it or the key body
    // persists raw in the tool-result row.
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Q\n" +
      "-----END RSA PRIVATE KEY-----";
    const out = redactCandidateValuesLegacy(`pem:\n${pem}\n`, [
      { service: "github-app", field: "pem", value: pem },
    ]);
    expect(out).not.toContain("MIIBOgIBAAJBAKj34GkxFhD90");
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).toBe('pem:\n<redacted type="Credential" />\n');
  });

  test("redactCandidateValuesLegacy does not depend on the sentinel flag's marker format", () => {
    // Round-17 case: the fallback protects legacy mode too — keeping a
    // route-proven plaintext out of persisted rows is independent of
    // which marker format the client renders. The output is the legacy
    // marker, valid on flag-off surfaces.
    const out = redactCandidateValuesLegacy("value: opaque-manual-secret", [
      { service: "svc", field: "f", value: "opaque-manual-secret" },
    ]);
    expect(out).toBe('value: <redacted type="Credential" />');
    expect(out).not.toContain("\u3014");
  });

  test("redactCandidateValuesLegacy covers the JSON-escaped form printed by reveal --json", async () => {
    // `reveal --json` stdout carries JSON.stringify({ok, value}) — a value
    // with newlines or quotes appears escaped, bytes the raw value can
    // never match. The resolved candidate list carries both encodings, so
    // the escaped body must be redacted too (the scanner alone would only
    // catch a recognizable header).
    const value = 'multi\nline"secret\\body';
    const candidates = await resolveRevealCandidates([
      { service: "svc", field: "f", provenValue: value },
    ]);
    const stdout = JSON.stringify({ ok: true, value });
    const out = redactCandidateValuesLegacy(stdout, candidates);
    expect(out).toContain('<redacted type="Credential" />');
    expect(out).not.toContain("multi");
    expect(out).not.toContain("secret");
  });

  test("redactCandidateValuesLegacy keeps emitted markers intact when a value appears inside them", () => {
    // The legacy marker's own text contains `redacted` \u2014 a candidate whose
    // plaintext is that word must not rewrite inside a marker just emitted
    // for another candidate.
    const out = redactCandidateValuesLegacy("value: hunter2-opaque-secret", [
      { service: "svc", field: "f", value: "hunter2-opaque-secret" },
      { service: "other", field: "g", value: "redacted" },
    ]);
    expect(out).toBe('value: <redacted type="Credential" />');
  });

  test("the persist fallback applies the duplicate-identity degrade rule", () => {
    const candidates = [
      { service: "svc", field: "f", value: "shared plain value" },
      { service: "other", field: "g", value: "shared plain value" },
    ];
    expect(redactSecretsForChat("echo shared plain value", candidates)).toBe(
      "echo \u3014redacted:Credential\u3015",
    );
  });

  test("a bare-unclassifiable duplicate plaintext degrades to the plain generic sentinel", () => {
    // The unique-identity degrade rule applies to fallback entries too:
    // two identities sharing an unclassifiable value must not mint an
    // identity-carrying chip for either.
    expect(
      buildLiveRevealGuardEntries([
        { service: "svc", field: "f", value: "shared plain value" },
        { service: "other", field: "g", value: "shared plain value" },
      ]),
    ).toEqual([
      {
        value: "shared plain value",
        replacement: "\u3014redacted:Credential\u3015",
      },
    ]);
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

  test("holds a completed value whole while a higher-priority match could claim its tail", () => {
    // Round-11 case: candidate A ends with a proper prefix of longer
    // (higher-priority) candidate B (`…-sk` / `sk-…`). At a chunk boundary
    // right after a complete A the outcome is genuinely ambiguous — the
    // next bytes decide whether the full-text swap consumes A or a B
    // starting inside A's tail — so A must be held WHOLE. Splitting A to
    // hold only B's prefix leaks A's head raw (the original round-11
    // report); committing A immediately leaks B's suffix raw when B
    // completes.
    const entries = [
      { value: "xx-sk", replacement: "[A]" },
      { value: "sk-yyyy", replacement: "[B]" },
    ];
    const first = drainSentinelGuardedText("token xx-sk", entries);
    expect(first.emitText).toBe("token ");
    expect(first.consumedRaw).toBe("token ");
    expect(first.bufferedRemainder).toBe("xx-sk");

    // Continuation 1: B completes inside A's tail — matches the unchunked
    // swap of `xx-sk-yyyy` (B wins, A's occurrence is blocked by overlap).
    const bWins = drainSentinelGuardedText(
      first.bufferedRemainder + "-yyyy ok",
      entries,
    );
    expect(bWins.emitText).toBe("xx-[B] ok");
    expect(bWins.consumedRaw).toBe("xx-sk-yyyy ok");
    expect(bWins.bufferedRemainder).toBe("");

    // Continuation 2: the threat dissolves — A swaps whole.
    const aWins = drainSentinelGuardedText(
      first.bufferedRemainder + " ok",
      entries,
    );
    expect(aWins.emitText).toBe("[A] ok");
    expect(aWins.consumedRaw).toBe("xx-sk ok");
    expect(aWins.bufferedRemainder).toBe("");
  });

  test("equal-length overlapping entries stay chunk-independent", () => {
    // Round-12 case: `aba` outranks `bab` (equal length, earlier in the
    // sorted order — same tie-break as `swapLiveRevealValues`). Chunks
    // `bab` + `a` must produce the same output as the unchunked swap of
    // `baba` (`b` + swapped `aba`), not commit the completed `bab` and
    // emit a raw trailing `a`.
    const entries = [
      { value: "aba", replacement: "[ABA]" },
      { value: "bab", replacement: "[BAB]" },
    ];
    const first = drainSentinelGuardedText("bab", entries);
    expect(first.emitText).toBe("");
    expect(first.consumedRaw).toBe("");
    expect(first.bufferedRemainder).toBe("bab");
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + "a",
      entries,
    );
    expect(second.emitText).toBe("b[ABA]");
    expect(second.consumedRaw).toBe("baba");
    expect(second.bufferedRemainder).toBe("");
  });

  test("commits an equal-length occurrence once no higher-priority prefix survives", () => {
    // Same entries, but the bytes after the completed `bab` rule out any
    // pending `aba` — the occurrence commits whole with no held tail.
    const entries = [
      { value: "aba", replacement: "[ABA]" },
      { value: "bab", replacement: "[BAB]" },
    ];
    const out = drainSentinelGuardedText("bab end", entries);
    expect(out.emitText).toBe("[BAB] end");
    expect(out.consumedRaw).toBe("bab end");
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

  test("swapLiveRevealValues never rewrites inside an earlier entry's replacement", () => {
    // A replacement sentinel is not inert text — it embeds service/field
    // segments. When another entry's plaintext equals one of those segments
    // (a credential whose value is literally `openai`), a sequential
    // split/join would corrupt the just-emitted sentinel into nested
    // markers; the swap must only consume raw-text spans.
    const entries = [
      {
        value: "sk-long-secret-0123456789",
        replacement: "\u3014redacted:Credential:openai:api_key\u3015",
      },
      {
        value: "openai",
        replacement: "\u3014redacted:Credential:manual:token\u3015",
      },
    ];
    expect(
      swapLiveRevealValues(
        "sk-long-secret-0123456789 spoke to openai",
        entries,
      ),
    ).toBe(
      "\u3014redacted:Credential:openai:api_key\u3015 spoke to \u3014redacted:Credential:manual:token\u3015",
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
