import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";

import "../__tests__/test-preload.js";
import {
  canonicalVerification,
  IngressVerificationSchema,
  MAX_FRESHNESS_TOLERANCE_SECONDS,
  STANDARD_WEBHOOKS_TOLERANCE_SECONDS,
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

const STANDARD_WEBHOOKS: IngressVerification = {
  kind: "standard-webhooks",
  secret: { field: "linq_webhook_secret" },
};

const BEARER: IngressVerification = {
  kind: "bearer",
  secret: { field: "shortcut_ingress_token" },
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
  opts: {
    secret?: string;
    nowMs?: number;
    requestUrl?: string;
    publicBaseUrl?: string;
  } = {},
) {
  return verifyDeclaredSignature({
    verification,
    headers: new Headers(headers),
    body: bytes(body),
    secret: opts.secret ?? SECRET,
    nowMs: opts.nowMs ?? NOW_MS,
    ...(opts.requestUrl !== undefined
      ? { requestUrl: opts.requestUrl }
      : {}),
    ...(opts.publicBaseUrl !== undefined
      ? { publicBaseUrl: opts.publicBaseUrl }
      : {}),
  });
}

/** An HMAC descriptor that signs a public URL and canonical form params. */
const URL_AND_FORM_HMAC: IngressVerification = {
  kind: "hmac",
  algorithm: "sha1",
  secret: { field: "auth_token" },
  signature: { header: "X-Provider-Signature", encoding: "base64" },
  payload: ["request-url", "form-params"],
};

/** Sign a form body as a public URL plus sorted key/value pairs. */
function urlAndFormSignature(
  url: string,
  params: Record<string, string>,
  secret = SECRET,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return createHmac("sha1", secret)
    .update(`${url}${sorted}`)
    .digest("base64");
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("the descriptor schema", () => {
  it("accepts the shapes the shipped plugins declare", () => {
    expect(IngressVerificationSchema.safeParse(BODY_ONLY).success).toBe(true);
    expect(IngressVerificationSchema.safeParse(TIMESTAMPED).success).toBe(true);
    expect(IngressVerificationSchema.safeParse(STANDARD_WEBHOOKS).success).toBe(
      true,
    );
    expect(IngressVerificationSchema.safeParse(BEARER).success).toBe(true);
    expect(IngressVerificationSchema.safeParse(URL_AND_FORM_HMAC).success).toBe(
      true,
    );
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

  it("rejects an unknown HMAC payload part", () => {
    expect(
      IngressVerificationSchema.safeParse({
        ...BODY_ONLY,
        payload: ["canonical-query"],
      }).success,
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

describe("bearer verification", () => {
  it("accepts a static token in the Authorization header", () => {
    expect(verify(BEARER, { Authorization: `Bearer ${SECRET}` }, "{}")).toEqual(
      { ok: true },
    );
  });

  it("rejects a missing or malformed bearer header", () => {
    expect(verify(BEARER, {}, "{}")).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    for (const authorization of [
      "Bearer",
      "Basic token",
      `Bearer ${SECRET} extra`,
    ]) {
      expect(verify(BEARER, { Authorization: authorization }, "{}")).toEqual({
        ok: false,
        reason: "malformed_signature",
      });
    }
  });

  it("does not accept a static token outside the Authorization header", () => {
    expect(verify(BEARER, { "X-Shortcut-Token": SECRET }, "{}")).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a different or unavailable stored token", () => {
    expect(
      verify(BEARER, { Authorization: "Bearer another-token" }, "{}"),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      verify(BEARER, { Authorization: `Bearer ${SECRET}` }, "{}", {
        secret: "",
      }),
    ).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("changes the approval descriptor when the token field changes", () => {
    expect(
      canonicalVerification({
        ...BEARER,
        secret: { field: "another_shortcut_token" },
      }),
    ).not.toBe(canonicalVerification(BEARER));
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

describe("standard-webhooks verification", () => {
  const KEY_BYTES = Buffer.from("standard-webhooks-test-key-bytes!!");
  const WHSEC = `whsec_${KEY_BYTES.toString("base64")}`;
  const MSG_ID = "msg_01JABC";
  const TS = String(Math.floor(NOW_MS / 1000));
  const BODY = '{"event_type":"message.received"}';

  function sign(
    body: string,
    opts: { id?: string; timestamp?: string; key?: Buffer } = {},
  ): string {
    const id = opts.id ?? MSG_ID;
    const timestamp = opts.timestamp ?? TS;
    const key = opts.key ?? KEY_BYTES;
    const digest = createHmac("sha256", key)
      .update(`${id}.${timestamp}.${body}`, "utf8")
      .digest("base64");
    return `v1,${digest}`;
  }

  function headers(
    signature: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      "webhook-id": MSG_ID,
      "webhook-timestamp": TS,
      "webhook-signature": signature,
      ...extra,
    };
  }

  it("accepts a delivery signed the spec's way", () => {
    expect(
      verify(STANDARD_WEBHOOKS, headers(sign(BODY)), BODY, { secret: WHSEC }),
    ).toEqual({ ok: true });
  });

  it("decodes a secret stored without the whsec_ prefix", () => {
    expect(
      verify(STANDARD_WEBHOOKS, headers(sign(BODY)), BODY, {
        secret: KEY_BYTES.toString("base64"),
      }),
    ).toEqual({ ok: true });
  });

  it("accepts any matching v1 signature when several are presented", () => {
    const other = createHmac("sha256", Buffer.from("other-key"))
      .update("x")
      .digest("base64");
    const presented = `v1,${other} ${sign(BODY)}`;
    expect(
      verify(STANDARD_WEBHOOKS, headers(presented), BODY, { secret: WHSEC }),
    ).toEqual({ ok: true });
  });

  it("covers the bytes as received, not a reserialization", () => {
    expect(
      verify(STANDARD_WEBHOOKS, headers(sign('{"a":1}')), '{ "a" : 1 }', {
        secret: WHSEC,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp", () => {
    const stale = String(
      Math.floor(NOW_MS / 1000) - STANDARD_WEBHOOKS_TOLERANCE_SECONDS - 1,
    );
    expect(
      verify(
        STANDARD_WEBHOOKS,
        headers(sign(BODY, { timestamp: stale }), {
          "webhook-timestamp": stale,
        }),
        BODY,
        { secret: WHSEC },
      ),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a header with no v1 signature as malformed", () => {
    expect(
      verify(STANDARD_WEBHOOKS, headers("v2,abcd"), BODY, { secret: WHSEC }),
    ).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("rejects a missing webhook-id as a missing payload header", () => {
    expect(
      verify(
        STANDARD_WEBHOOKS,
        {
          "webhook-timestamp": TS,
          "webhook-signature": sign(BODY),
        },
        BODY,
        { secret: WHSEC },
      ),
    ).toEqual({ ok: false, reason: "missing_payload_header" });
  });

  it("changes the digest when the secret field changes", () => {
    expect(
      canonicalVerification({
        ...STANDARD_WEBHOOKS,
        secret: { field: "other_secret" },
      }),
    ).not.toBe(canonicalVerification(STANDARD_WEBHOOKS));
  });
});

describe("HMAC URL and form payloads", () => {
  const MESSAGE_URL =
    "https://assistant.example.test/webhooks/plugins/sms/events-twilio/";
  const PARAMS = {
    MessageSid: "SM01",
    AccountSid: "AC01",
    From: "+15555550101",
    To: "+15555550102",
    Body: "hello there",
  };

  it("verifies a delivery signed over the raw request URL", () => {
    const result = verify(
      URL_AND_FORM_HMAC,
      { "X-Provider-Signature": urlAndFormSignature(MESSAGE_URL, PARAMS) },
      formBody(PARAMS),
      { requestUrl: MESSAGE_URL },
    );
    expect(result).toEqual({ ok: true });
  });

  it("verifies against a forwarded-header URL when the raw URL differs", () => {
    // The gateway sits behind a reverse proxy: the vendor signed the public
    // spelling, while the gateway sees localhost.
    const publicSignature = urlAndFormSignature(MESSAGE_URL, PARAMS);
    const result = verify(
      URL_AND_FORM_HMAC,
      {
        "X-Provider-Signature": publicSignature,
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "assistant.example.test",
      },
      formBody(PARAMS),
      { requestUrl: "http://127.0.0.1:8080/webhooks/plugins/sms/events-twilio/" },
    );
    expect(result).toEqual({ ok: true });
  });

  it("verifies against the platform-injected URL first", () => {
    const injected =
      "https://platform.example.test/v1/gateway/callbacks/abc123";
    const result = verify(
      URL_AND_FORM_HMAC,
      {
        "X-Provider-Signature": urlAndFormSignature(injected, PARAMS),
        "X-Vellum-Ingress-Url": injected,
      },
      formBody(PARAMS),
      { requestUrl: "http://127.0.0.1:8080/webhooks/plugins/sms/events-twilio/" },
    );
    expect(result).toEqual({ ok: true });
  });

  it("verifies against the configured public base when set", () => {
    const result = verify(
      URL_AND_FORM_HMAC,
      {
        "X-Provider-Signature": urlAndFormSignature(MESSAGE_URL, PARAMS),
      },
      formBody(PARAMS),
      {
        requestUrl:
          "http://127.0.0.1:8080/webhooks/plugins/sms/events-twilio/",
        publicBaseUrl: "https://assistant.example.test",
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a signature computed with the wrong secret", () => {
    const result = verify(
      URL_AND_FORM_HMAC,
      {
        "X-Provider-Signature": urlAndFormSignature(
          MESSAGE_URL,
          PARAMS,
          "someone-elses-token",
        ),
      },
      formBody(PARAMS),
      { requestUrl: MESSAGE_URL },
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature over different params", () => {
    const tampered = { ...PARAMS, Body: "wire fraud" };
    const result = verify(
      URL_AND_FORM_HMAC,
      { "X-Provider-Signature": urlAndFormSignature(MESSAGE_URL, PARAMS) },
      formBody(tampered),
      { requestUrl: MESSAGE_URL },
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a missing signature header", () => {
    const result = verify(URL_AND_FORM_HMAC, {}, formBody(PARAMS), {
      requestUrl: MESSAGE_URL,
    });
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("fails closed when the caller cannot say what URL it serves", () => {
    const result = verify(
      URL_AND_FORM_HMAC,
      { "X-Provider-Signature": urlAndFormSignature(MESSAGE_URL, PARAMS) },
      formBody(PARAMS),
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("sorts params by key regardless of wire order", () => {
    // The signing scheme sorts parameter names. URLSearchParams preserves
    // insertion order, so the verifier must sort rather than concatenate as-is.
    const ordered = new URLSearchParams(
      "To=%2B15555550102&Body=hello+there&MessageSid=SM01&From=%2B15555550101&AccountSid=AC01",
    );
    const result = verify(
      URL_AND_FORM_HMAC,
      { "X-Provider-Signature": urlAndFormSignature(MESSAGE_URL, PARAMS) },
      ordered.toString(),
      { requestUrl: MESSAGE_URL },
    );
    expect(result).toEqual({ ok: true });
  });
});
