import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";

import "../__tests__/test-preload.js";
import {
  canonicalVerification,
  IngressVerificationSchema,
  MAX_FRESHNESS_TOLERANCE_SECONDS,
  verifyDeclaredSignature,
  type IngressVerification,
} from "./ingress-verification.js";

const SECRET = "whsec_test";
const NOW_MS = 1_700_000_000_000;

const BODY_ONLY: IngressVerification = {
  kind: "hmac",
  algorithm: "sha256",
  secret: { field: "comms_webhook_secret" },
  signature: { header: "X-Osis-Signature", encoding: "hex", prefix: "sha256=" },
  payload: ["body"],
};

const TIMESTAMPED: IngressVerification = {
  kind: "hmac",
  algorithm: "sha256",
  secret: { field: "photon_webhook_secret" },
  signature: {
    header: "X-Spectrum-Signature",
    encoding: "hex",
    prefix: "v0=",
  },
  payload: [
    { literal: "v0:" },
    { header: "X-Spectrum-Timestamp" },
    { literal: ":" },
    "body",
  ],
  freshness: {
    header: "X-Spectrum-Timestamp",
    format: "unix-seconds",
    toleranceSeconds: 300,
  },
};

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function digest(
  payload: string,
  encoding: "hex" | "base64" = "hex",
  secret = SECRET,
): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest(encoding);
}

function verify(
  verification: IngressVerification,
  headers: Record<string, string>,
  body: string,
  opts: { secret?: string; nowMs?: number } = {},
) {
  return verifyDeclaredSignature({
    verification,
    headers: new Headers(headers),
    body: bytes(body),
    secret: opts.secret ?? SECRET,
    nowMs: opts.nowMs ?? NOW_MS,
  });
}

describe("the descriptor schema", () => {
  it("accepts the shapes the shipped plugins declare", () => {
    expect(IngressVerificationSchema.safeParse(BODY_ONLY).success).toBe(true);
    expect(IngressVerificationSchema.safeParse(TIMESTAMPED).success).toBe(true);
  });

  it("rejects an unknown kind rather than falling back to a default", () => {
    // A route the plugin believes is verified one way and the gateway
    // verifies another is worse than no route.
    const parsed = IngressVerificationSchema.safeParse({
      ...BODY_ONLY,
      kind: "jwt",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown algorithm or encoding", () => {
    expect(
      IngressVerificationSchema.safeParse({ ...BODY_ONLY, algorithm: "md5" })
        .success,
    ).toBe(false);
    expect(
      IngressVerificationSchema.safeParse({
        ...BODY_ONLY,
        signature: { ...BODY_ONLY.signature, encoding: "base64url" },
      }).success,
    ).toBe(false);
  });

  it("rejects an unrecognized key", () => {
    expect(
      IngressVerificationSchema.safeParse({ ...BODY_ONLY, tolerate: true })
        .success,
    ).toBe(false);
  });

  it("rejects a credential field that could reach out of the plugin's service", () => {
    for (const field of [
      "../vellum/webhook_secret",
      "vellum/webhook_secret",
      "Webhook_Secret",
      "",
    ]) {
      const parsed = IngressVerificationSchema.safeParse({
        ...BODY_ONLY,
        secret: { field },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects a descriptor naming a service rather than a field", () => {
    // The service half is composed gateway-side from the plugin's directory
    // name, so a manifest may not supply one.
    expect(
      IngressVerificationSchema.safeParse({
        ...BODY_ONLY,
        secret: { service: "vellum", field: "webhook_secret" },
      }).success,
    ).toBe(false);
  });

  it("rejects an empty payload", () => {
    expect(
      IngressVerificationSchema.safeParse({ ...BODY_ONLY, payload: [] })
        .success,
    ).toBe(false);
  });

  it("bounds a declared replay window", () => {
    const overWindow = {
      ...TIMESTAMPED,
      freshness: {
        ...TIMESTAMPED.freshness,
        toleranceSeconds: MAX_FRESHNESS_TOLERANCE_SECONDS + 1,
      },
    };
    expect(IngressVerificationSchema.safeParse(overWindow).success).toBe(false);
  });
});

describe("body-only verification", () => {
  it("accepts a correct signature", () => {
    const body = '{"event":"comms.message.received"}';
    const result = verify(
      BODY_ONLY,
      { "X-Osis-Signature": `sha256=${digest(body)}` },
      body,
    );
    expect(result).toEqual({ ok: true });
  });

  it("covers the bytes as received, not a reserialization", () => {
    const signed = '{"a":1}';
    const delivered = '{ "a" : 1 }';
    const result = verify(
      BODY_ONLY,
      { "X-Osis-Signature": `sha256=${digest(signed)}` },
      delivered,
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("reports a missing header separately from a wrong signature", () => {
    expect(verify(BODY_ONLY, {}, "{}")).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a signature missing its declared prefix", () => {
    const result = verify(
      BODY_ONLY,
      { "X-Osis-Signature": digest("{}") },
      "{}",
    );
    expect(result).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("rejects a digest that is not the declared encoding", () => {
    // `Buffer.from` drops characters it does not recognize, so a lenient
    // decode could shorten an attacker's digest into a match.
    for (const presented of ["sha256=zzzz", "sha256=abc", "sha256="]) {
      const result = verify(BODY_ONLY, { "X-Osis-Signature": presented }, "{}");
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a truncated digest rather than comparing a prefix", () => {
    const full = digest("{}");
    const result = verify(
      BODY_ONLY,
      { "X-Osis-Signature": `sha256=${full.slice(0, 16)}` },
      "{}",
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with a different secret", () => {
    const result = verify(
      BODY_ONLY,
      { "X-Osis-Signature": `sha256=${digest("{}", "hex", "other")}` },
      "{}",
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("treats an empty stored secret as unverifiable", () => {
    const result = verify(
      BODY_ONLY,
      { "X-Osis-Signature": `sha256=${digest("{}")}` },
      "{}",
      { secret: "" },
    );
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("accepts a base64 digest when that is what was declared", () => {
    const base64Descriptor: IngressVerification = {
      ...BODY_ONLY,
      signature: { header: "X-Sig", encoding: "base64" },
    };
    const result = verify(
      base64Descriptor,
      { "X-Sig": digest("{}", "base64") },
      "{}",
    );
    expect(result).toEqual({ ok: true });
  });
});

describe("timestamped verification", () => {
  const body = '{"event":"message.received"}';
  const seconds = Math.floor(NOW_MS / 1000);

  function signedAt(ts: number, payloadBody = body): Record<string, string> {
    return {
      "X-Spectrum-Timestamp": String(ts),
      "X-Spectrum-Signature": `v0=${digest(`v0:${ts}:${payloadBody}`)}`,
    };
  }

  it("accepts a delivery inside the window", () => {
    expect(verify(TIMESTAMPED, signedAt(seconds), body)).toEqual({ ok: true });
  });

  it("accepts a clock a little ahead of ours", () => {
    expect(verify(TIMESTAMPED, signedAt(seconds + 60), body)).toEqual({
      ok: true,
    });
  });

  it("rejects a replay past the window", () => {
    expect(verify(TIMESTAMPED, signedAt(seconds - 3600), body)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("rejects a delivery with no timestamp", () => {
    const result = verify(
      TIMESTAMPED,
      { "X-Spectrum-Signature": `v0=${digest(`v0::${body}`)}` },
      body,
    );
    expect(result).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("rejects an unparsable timestamp", () => {
    const result = verify(
      TIMESTAMPED,
      {
        "X-Spectrum-Timestamp": "not-a-number",
        "X-Spectrum-Signature": `v0=${digest(`v0:not-a-number:${body}`)}`,
      },
      body,
    );
    expect(result).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("binds the timestamp into the signature", () => {
    // Restamping a captured delivery must not make it fresh again.
    const headers = signedAt(seconds - 3600);
    headers["X-Spectrum-Timestamp"] = String(seconds);
    expect(verify(TIMESTAMPED, headers, body)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("reports a payload header that is absent without a freshness rule", () => {
    const noFreshness: IngressVerification = {
      ...TIMESTAMPED,
      freshness: undefined,
    };
    const result = verify(
      noFreshness,
      { "X-Spectrum-Signature": `v0=${digest(`v0::${body}`)}` },
      body,
    );
    expect(result).toEqual({ ok: false, reason: "missing_payload_header" });
  });

  it("reads unix-millis and rfc3339 timestamps", () => {
    const millis: IngressVerification = {
      ...TIMESTAMPED,
      payload: ["body"],
      freshness: {
        header: "X-Ts",
        format: "unix-millis",
        toleranceSeconds: 300,
      },
    };
    expect(
      verify(
        millis,
        {
          "X-Ts": String(NOW_MS),
          "X-Spectrum-Signature": `v0=${digest(body)}`,
        },
        body,
      ),
    ).toEqual({ ok: true });

    const rfc: IngressVerification = {
      ...millis,
      freshness: { header: "X-Ts", format: "rfc3339", toleranceSeconds: 300 },
    };
    expect(
      verify(
        rfc,
        {
          "X-Ts": new Date(NOW_MS).toISOString(),
          "X-Spectrum-Signature": `v0=${digest(body)}`,
        },
        body,
      ),
    ).toEqual({ ok: true });
  });
});

describe("canonicalVerification", () => {
  it("is stable under key reordering", () => {
    const reordered = IngressVerificationSchema.parse({
      payload: ["body"],
      signature: {
        prefix: "sha256=",
        encoding: "hex",
        header: "X-Osis-Signature",
      },
      secret: { field: "comms_webhook_secret" },
      algorithm: "sha256",
      kind: "hmac",
    });
    expect(canonicalVerification(reordered)).toBe(
      canonicalVerification(BODY_ONLY),
    );
  });

  it("changes when the secret field changes", () => {
    expect(
      canonicalVerification({
        ...BODY_ONLY,
        secret: { field: "other_secret" },
      }),
    ).not.toBe(canonicalVerification(BODY_ONLY));
  });

  it("changes when the covered bytes change", () => {
    expect(
      canonicalVerification({ ...BODY_ONLY, payload: [{ literal: "x" }] }),
    ).not.toBe(canonicalVerification(BODY_ONLY));
  });

  it("keeps payload order, which is part of what is signed", () => {
    const forward: IngressVerification = {
      ...BODY_ONLY,
      payload: [{ literal: "a" }, "body"],
    };
    const reversed: IngressVerification = {
      ...BODY_ONLY,
      payload: ["body", { literal: "a" }],
    };
    expect(canonicalVerification(forward)).not.toBe(
      canonicalVerification(reversed),
    );
  });
});
