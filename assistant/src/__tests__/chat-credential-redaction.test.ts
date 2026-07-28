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
import { neutralizeRedactedSentinels } from "@vellumai/service-contracts/redacted-credential";

import {
  buildForChatSentinel,
  buildLiveRevealGuardEntries,
  collectRevealRefsFromCommand,
  drainCandidateGuardedChunk,
  drainSentinelGuardedText,
  filterRefsByRevealProof,
  guardForChatSentinels,
  redactCandidateValuesLegacy,
  redactSecretsForChat,
  remintAuthoritiesFromCandidates,
  resolveProvenRevealCandidates,
  resolveRefIdentities,
  resolveRevealCandidates,
  swapLiveRevealValues,
} from "../daemon/chat-credential-redaction.js";
import {
  currentForChatMintWatermark,
  forChatMintsSince,
  recordForChatMint,
  resetForChatMintRegistryForTest,
} from "../runtime/for-chat-mint-registry.js";
import {
  _resetRevealSuccessRegistryForTest,
  openRevealProofWindow,
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

  test("a quoted separator inside a flag value does not split the invocation", () => {
    // Service/field identifiers are arbitrary strings; a shell separator
    // inside quotes is part of the value. Cutting there would orphan the
    // flags across two broken segments and stage nothing — and an
    // unstageable reveal's opaque output could stream or persist raw.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service 'R&D' --field token",
      ),
    ).toEqual([{ service: "R&D", field: "token" }]);
  });

  test("quoted separators cannot swallow a following invocation", () => {
    expect(
      collectRevealRefsFromCommand(
        'assistant credentials reveal --service "a&&b;c" --field x && assistant credentials reveal --service d --field e',
      ),
    ).toEqual([
      { service: "a&&b;c", field: "x" },
      { service: "d", field: "e" },
    ]);
  });

  test("unescapes backslash-escaped characters in unquoted flag values", () => {
    // The shell strips escaping before the CLI sees argv, so the reveal
    // route records proof under the UNESCAPED identity — the parse must
    // agree or the staged ref can never match its proof.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service foo\\ bar --field token",
      ),
    ).toEqual([{ service: "foo bar", field: "token" }]);
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a\\&b --field x",
      ),
    ).toEqual([{ service: "a&b", field: "x" }]);
  });

  test("unescapes POSIX-escapable characters inside double-quoted values", () => {
    expect(
      collectRevealRefsFromCommand(
        'assistant credentials reveal --service "a\\"b" --field x',
      ),
    ).toEqual([{ service: 'a"b', field: "x" }]);
  });

  test("stages every reveal invocation within one segment", () => {
    // Command substitution nests several reveals in ONE segment; each must
    // stage its own ref — parsing only the first flag pair would leave the
    // later identities unstaged even though the route proves them.
    expect(
      collectRevealRefsFromCommand(
        'echo "$(assistant credentials reveal --service a --field token)" "$(assistant credentials reveal --service b --field token)"',
      ),
    ).toEqual([
      { service: "a", field: "token" },
      { service: "b", field: "token" },
    ]);
  });

  test("a substitution's closing paren does not glue onto the parsed value", () => {
    expect(
      collectRevealRefsFromCommand(
        'KEY="$(assistant credentials reveal --service openai --field api_key)"',
      ),
    ).toEqual([{ service: "openai", field: "api_key" }]);
  });

  test("stages two UUID reveals nested in one segment", () => {
    const other = "99999999-9999-4999-8999-999999999999";
    expect(
      collectRevealRefsFromCommand(
        `echo "$(assistant credentials reveal ${UUID})" "$(assistant credentials reveal ${other})"`,
      ),
    ).toEqual([{ id: UUID }, { id: other }]);
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

  test("drops values below the exact-match length floor", async () => {
    // The fallback global-replaces every occurrence of a candidate's bytes
    // for the rest of the turn; a trivial value like `ok` would shred
    // unrelated text into markers, and below the floor the value carries
    // no meaningful entropy to protect anyway.
    const out = await resolveRevealCandidates([
      { service: "svc", field: "f", provenValue: "ok" },
      { service: "svc", field: "g", provenValue: "12345" },
      { service: "svc", field: "h", provenValue: "123456" },
    ]);
    expect(out).toEqual([{ service: "svc", field: "h", value: "123456" }]);
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
    openRevealProofWindow();
    recordRevealSuccess(
      "gone-service",
      "api_key",
      "hunter2-removed",
      "nonce-test",
    );
    const proven = filterRefsByRevealProof(
      [
        {
          id: "99999999-9999-4999-8999-999999999999",
          service: "gone-service",
          field: "api_key",
        },
      ],
      0,
      "nonce-test",
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

  test("a secret-shaped service name is not re-scanned inside the minted sentinel", () => {
    // The credential routes accept arbitrary service strings — one can look
    // exactly like a known key format, and the sentinel embeds it as
    // readable text between colons. The scanner must only run over the text
    // between candidate spans; a match inside the just-minted sentinel
    // would corrupt it into a nested marker and lose the chip.
    const out = redactSecretsForChat("v: hunter2-opaque-secret end", [
      {
        service: SYNTHETIC_OPENAI_PROJECT_KEY,
        field: "api_key",
        value: "hunter2-opaque-secret",
      },
    ]);
    expect(out).toBe(
      `v: \u3014redacted:Credential:${SYNTHETIC_OPENAI_PROJECT_KEY}:api_key\u3015 end`,
    );
  });

  test("a longer scanner match outranks a candidate substring inside it", () => {
    // A proven manual value can be a strict substring of a DIFFERENT
    // scanner-detectable secret. Carving the candidate's bytes out of the
    // enclosing key would leave the key's suffix raw — the scanner must
    // redact the whole key instead.
    const candidates = [{ service: "svc", field: "f", value: "sk-pro" }];
    const out = redactSecretsForChat(
      `key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
      candidates,
    );
    expect(out).toBe("key: \u3014redacted:OpenAI Project Key\u3015");
    // A standalone occurrence still gets the exact-match fallback.
    expect(redactSecretsForChat("v: sk-pro end", candidates)).toBe(
      "v: \u3014redacted:Credential:svc:f\u3015 end",
    );
  });

  test("a candidate value containing the sentinel trigger is still redacted whole", () => {
    // Manual credential values are arbitrary strings — one may embed the
    // sentinel trigger itself. Neutralizing the whole text BEFORE the
    // exact-match pass would mutate the value's occurrence and the protect
    // pass would miss it, so candidate spans resolve on the raw bytes and
    // neutralization applies only to the text between them.
    const value = "weird\u3014redacted:inner\u3015token";
    const out = redactSecretsForChat(`v: ${value} end`, [
      { service: "svc", field: "f", value },
    ]);
    expect(out).toBe("v: \u3014redacted:Credential:svc:f\u3015 end");
    expect(out).not.toContain("weird");
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
    // Several scanner patterns only match WITH context
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
    // The live guard swaps a scanner-unclassifiable value,
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
    // The reveal command's own stdout persists into the
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
    // The fallback protects legacy mode too — keeping a
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

  test("redactCandidateValuesLegacy lets the scanner redact an enclosing secret whole", () => {
    const out = redactCandidateValuesLegacy(
      `key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`,
      [{ service: "svc", field: "f", value: "sk-pro" }],
    );
    expect(out).toBe(`key: ${OPENAI_PROJECT_KEY_REDACTION_MARKER}`);
  });

  test("redactCandidateValuesLegacy covers a value containing the sentinel trigger", () => {
    // Same raw-bytes-first ordering as the sentinel path: neutralizing the
    // whole text before the exact match would mutate the value's occurrence
    // and the opaque secret would persist almost intact.
    const value = "weird\u3014redacted:inner\u3015token";
    const out = redactCandidateValuesLegacy(`v: ${value} end`, [
      { service: "svc", field: "f", value },
    ]);
    expect(out).toBe('v: <redacted type="Credential" /> end');
    expect(out).not.toContain("weird");
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
    // Candidate A ends with a proper prefix of longer
    // (higher-priority) candidate B (`…-sk` / `sk-…`). At a chunk boundary
    // right after a complete A the outcome is genuinely ambiguous — the
    // next bytes decide whether the full-text swap consumes A or a B
    // starting inside A's tail — so A must be held WHOLE. Splitting A to
    // hold only B's prefix leaks A's head raw; committing A immediately
    // leaks B's suffix raw when B completes.
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
    // `aba` outranks `bab` (equal length, earlier in the
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

  test("the live guard swaps a value containing the sentinel trigger", () => {
    // The emit transform resolves candidate spans and forgery
    // neutralization together on the raw bytes — sequencing neutralization
    // first would mutate this value's occurrence and stream it raw.
    const value = "weird\u3014redacted:inner\u3015token";
    const candidates = [{ service: "svc", field: "f", value }];
    const entries = buildLiveRevealGuardEntries(candidates);
    const out = drainSentinelGuardedText(`v: ${value} end`, entries);
    expect(out.emitText).toBe("v: \u3014redacted:Credential:svc:f\u3015 end");
    expect(out.bufferedRemainder).toBe("");
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

describe("--for-chat (daemon-minted sentinel channel)", () => {
  const FOR_CHAT_CANDIDATE = {
    service: "openai",
    field: "api_key",
    value: SYNTHETIC_OPENAI_PROJECT_KEY,
  };
  const CANONICAL = buildForChatSentinel(FOR_CHAT_CANDIDATE);
  const MINT = {
    service: "openai",
    field: "api_key",
    sentinel: CANONICAL,
  };

  test("collectRevealRefsFromCommand carries no --for-chat signal — executed mints are the only authority", () => {
    // A parse of the requested command must never authorize re-minting: a
    // segment that merely QUOTES a reveal invocation (echo '… --for-chat …')
    // parses identically to one that runs it. The refs exist only to scope
    // the plaintext-swap candidate fetch; the re-mint allowlist comes from
    // the route-recorded mint registry and from candidates PROVEN by the
    // reveal-success registry.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --for-chat --service openai --field api_key",
      ),
    ).toEqual([{ service: "openai", field: "api_key" }]);
    expect(
      collectRevealRefsFromCommand(
        `assistant credentials reveal ${UUID} --for-chat`,
      ),
    ).toEqual([{ id: UUID }]);
  });

  test("buildForChatSentinel stamps the scanner's type label", () => {
    expect(CANONICAL).toBe(
      "\u3014redacted:OpenAI Project Key:openai:api_key\u3015",
    );
  });

  test("buildForChatSentinel falls back to a generic label for unscannable values", () => {
    expect(
      buildForChatSentinel({
        service: "svc",
        field: "f",
        value: "plain-value-no-pattern",
      }),
    ).toBe("\u3014redacted:Credential:svc:f\u3015");
  });

  test("guardForChatSentinels re-mints an identity match, even with a tampered type label", () => {
    const echoed = `Your key: ${CANONICAL} — click to reveal.`;
    expect(guardForChatSentinels(echoed, [MINT])).toBe(echoed);
    // A hand-altered type label is canonicalized away, not trusted — the
    // replacement is the route's original mint.
    const tampered = "see \u3014redacted:GitHub Token:openai:api_key\u3015";
    expect(guardForChatSentinels(tampered, [MINT])).toBe(`see ${CANONICAL}`);
  });

  test("guardForChatSentinels neutralizes unknown identities and plain shapes", () => {
    const unknown = "\u3014redacted:API Key:github-app:pem\u3015";
    const plain = "\u3014redacted:API Key\u3015";
    const out = guardForChatSentinels(`${unknown} ${plain}`, [MINT]);
    expect(out).toBe(
      "\u3014\u2060redacted:API Key:github-app:pem\u3015 \u3014\u2060redacted:API Key\u3015",
    );
  });

  test("guardForChatSentinels equals plain neutralization with no recorded mints", () => {
    const text = `x ${CANONICAL} y \u3014redac partial`;
    expect(guardForChatSentinels(text, [])).toBe(
      neutralizeRedactedSentinels(text),
    );
  });

  test("redactSecretsForChat preserves the daemon-minted sentinel and still redacts plaintext", () => {
    const text = `chip ${CANONICAL} and raw ${SYNTHETIC_OPENAI_PROJECT_KEY}`;
    const out = redactSecretsForChat(text, [FOR_CHAT_CANDIDATE], [MINT]);
    expect(out).toBe(`chip ${CANONICAL} and raw ${CANONICAL}`);
    expect(out).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("a secret embedded inside a forged sentinel is still scanner-redacted", () => {
    // The forged span's identity matches no authority, so its bytes run
    // the full neutralize+scan pipeline — an attacker cannot smuggle a
    // real key through persistence by dressing it as a sentinel.
    const forged = `\u3014redacted:x:svc:${SYNTHETIC_OPENAI_PROJECT_KEY}\u3015`;
    const out = redactSecretsForChat(forged, [], [MINT]);
    expect(out).not.toContain(SYNTHETIC_OPENAI_PROJECT_KEY);
  });

  test("a candidate list alone is not re-mint authority (quoted command grants nothing)", () => {
    // The quoted-command scenario: the identity IS a reveal candidate
    // (staging parsed the echoed text), but the route never executed the
    // reveal, so no proof exists, handlers derive no authorities, and the
    // echoed sentinel is neutralized like any other forgery.
    const out = redactSecretsForChat(`chip ${CANONICAL}`, [FOR_CHAT_CANDIDATE]);
    expect(out).toBe(`chip ${neutralizeRedactedSentinels(CANONICAL)}`);
  });

  test("stream guard holds an unclosed trigger open until the sentinel completes, then re-mints", () => {
    const head = CANONICAL.slice(0, 20); // past the trigger, before the close
    const tail = CANONICAL.slice(20);
    const first = drainSentinelGuardedText(`token: ${head}`, [], [MINT]);
    expect(first.emitText).toBe("token: ");
    expect(first.bufferedRemainder).toBe(head);
    const second = drainSentinelGuardedText(
      first.bufferedRemainder + tail + " done",
      [],
      [MINT],
    );
    expect(second.emitText).toBe(`${CANONICAL} done`);
    expect(second.bufferedRemainder).toBe("");
  });

  test("stream guard still eagerly neutralizes complete triggers without recorded mints", () => {
    const out = drainSentinelGuardedText("x \u3014redacted:oops not closed");
    expect(out.emitText).toBe("x \u3014\u2060redacted:oops not closed");
    expect(out.bufferedRemainder).toBe("");
  });

  test("stream guard releases (neutralized) an unclosed trigger past the hold cap", () => {
    const forged = "\u3014redacted:" + "a".repeat(600);
    const out = drainSentinelGuardedText(`pre ${forged}`, [], [MINT]);
    expect(out.emitText).toContain("\u3014\u2060redacted:");
    expect(out.bufferedRemainder).toBe("");
  });
});

describe("plain-reveal re-mint authorities (retyped sentinel after a proven reveal)", () => {
  const CANDIDATE = {
    service: "test",
    field: "qa_token",
    value: "hunter2-manual-token-value",
  };
  const CANONICAL = buildForChatSentinel(CANDIDATE);
  const AUTHORITIES = remintAuthoritiesFromCandidates([CANDIDATE]);

  test("remintAuthoritiesFromCandidates builds one canonical authority per identity", () => {
    // Encoding-variant candidates share an identity and must not produce
    // duplicate authorities; the sentinel is minted from the first
    // candidate's own metadata, never from any retyped span.
    const variants = [
      CANDIDATE,
      { ...CANDIDATE, value: "hunter2-manual\\ntoken" },
    ];
    expect(remintAuthoritiesFromCandidates(variants)).toEqual([
      {
        service: "test",
        field: "qa_token",
        sentinel: CANONICAL,
      },
    ]);
  });

  test("persist re-mints a model-retyped sentinel whose identity was proven this turn", () => {
    // The LUM-2768 repro: history shows the model its own redacted reply;
    // asked to "show it again", it retypes the sentinel instead of echoing
    // the plaintext. With the identity proven this turn, the retyped span
    // is restored to the canonical mint instead of degrading to
    // neutralized glyph text.
    const retyped = `here it is again: ${CANONICAL}`;
    expect(redactSecretsForChat(retyped, [CANDIDATE], AUTHORITIES)).toBe(
      retyped,
    );
  });

  test("a tampered label on a proven identity canonicalizes instead of neutralizing", () => {
    const tampered = "\u3014redacted:GitHub Token:test:qa_token\u3015";
    expect(redactSecretsForChat(tampered, [CANDIDATE], AUTHORITIES)).toBe(
      CANONICAL,
    );
  });

  test("live guard re-mints the retyped sentinel so the wire matches persistence", () => {
    const out = drainSentinelGuardedText(
      `again: ${CANONICAL}!`,
      [],
      AUTHORITIES,
    );
    expect(out.emitText).toBe(`again: ${CANONICAL}!`);
    expect(out.bufferedRemainder).toBe("");
  });

  test("an unproven identity still neutralizes even with other authorities present", () => {
    const other = "\u3014redacted:Credential:prod:api_key\u3015";
    expect(redactSecretsForChat(other, [CANDIDATE], AUTHORITIES)).toBe(
      neutralizeRedactedSentinels(other),
    );
  });
});

describe("for-chat mint registry", () => {
  test("returns only mints recorded after the captured watermark", () => {
    resetForChatMintRegistryForTest();
    recordForChatMint({
      service: "old",
      field: "f",
      sentinel: "s0",
      nonce: "n1",
    });
    const watermark = currentForChatMintWatermark();
    expect(forChatMintsSince(watermark)).toEqual([]);
    recordForChatMint({
      service: "openai",
      field: "api_key",
      sentinel: "s1",
      nonce: "n1",
    });
    expect(forChatMintsSince(watermark)).toEqual([
      { service: "openai", field: "api_key", sentinel: "s1", nonce: "n1" },
    ]);
    // A turn that started before the first mint sees both identities.
    expect(forChatMintsSince(0)).toHaveLength(2);
    resetForChatMintRegistryForTest();
  });

  test("records carry the executing conversation's nonce for consumer-side binding", () => {
    // The registry stores the secret nonce the executing tool shell
    // forwarded; the agent loop accepts only records matching its own
    // conversation's nonce AND an identity its run staged, so a concurrent
    // conversation's executed reveal never authorizes another that merely
    // names the identity.
    resetForChatMintRegistryForTest();
    recordForChatMint({
      service: "openai",
      field: "api_key",
      sentinel: "s1",
      nonce: "n1",
    });
    expect(forChatMintsSince(0)).toEqual([
      { service: "openai", field: "api_key", sentinel: "s1", nonce: "n1" },
    ]);
    resetForChatMintRegistryForTest();
  });

  test("dedupes per nonce+identity with the latest sentinel winning", () => {
    resetForChatMintRegistryForTest();
    recordForChatMint({
      service: "svc",
      field: "f",
      sentinel: "first",
      nonce: "n1",
    });
    recordForChatMint({
      service: "svc",
      field: "f",
      sentinel: "second",
      nonce: "n1",
    });
    expect(forChatMintsSince(0)).toEqual([
      { service: "svc", field: "f", sentinel: "second", nonce: "n1" },
    ]);
    resetForChatMintRegistryForTest();
  });

  test("concurrent same-credential reveals from different conversations both survive", () => {
    // The dedupe key includes the nonce: consumers filter by THEIR nonce
    // after this call, so an identity-only dedupe would let conversation
    // B's later reveal of the same credential clobber conversation A's
    // legitimate mint and neutralize A's echoed sentinel.
    resetForChatMintRegistryForTest();
    recordForChatMint({
      service: "svc",
      field: "f",
      sentinel: "s-a",
      nonce: "nonce-a",
    });
    recordForChatMint({
      service: "svc",
      field: "f",
      sentinel: "s-b",
      nonce: "nonce-b",
    });
    const mints = forChatMintsSince(0);
    expect(mints).toHaveLength(2);
    expect(mints.find((m) => m.nonce === "nonce-a")?.sentinel).toBe("s-a");
    expect(mints.find((m) => m.nonce === "nonce-b")?.sentinel).toBe("s-b");
    resetForChatMintRegistryForTest();
  });
});
