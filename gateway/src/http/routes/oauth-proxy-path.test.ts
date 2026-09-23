import { describe, expect, test } from "bun:test";

import {
  oauthProxySegmentFromSubject,
  rewriteOAuthProxyUpstreamPath,
} from "./oauth-proxy-path.js";

const GOOGLE_SUB = "local:self:oauth-proxy.google";
const PINNED_SUB = "local:self:oauth-proxy.google@user%40example.com";
const STRIPE_SUB = "local:self:oauth-proxy.stripe_link";

describe("oauthProxySegmentFromSubject", () => {
  test("reads the bare provider from an unpinned grant", () => {
    expect(oauthProxySegmentFromSubject(GOOGLE_SUB)).toBe("google");
  });

  test("keeps the encoded account on a pinned grant", () => {
    expect(oauthProxySegmentFromSubject(PINNED_SUB)).toBe(
      "google@user%40example.com",
    );
  });

  test("returns null for a non-grant subject", () => {
    expect(oauthProxySegmentFromSubject("actor:self:user-123")).toBeNull();
    expect(oauthProxySegmentFromSubject("local:self:conv-xyz")).toBeNull();
    expect(oauthProxySegmentFromSubject("local:self:oauth-proxy.")).toBeNull();
  });
});

describe("rewriteOAuthProxyUpstreamPath", () => {
  test("prefixes a Gmail media-upload path so the daemon catch-all sees it", () => {
    expect(
      rewriteOAuthProxyUpstreamPath(
        "/upload/gmail/v1/users/me/drafts",
        GOOGLE_SUB,
      ),
    ).toBe("/v1/oauth/proxy/google/upload/gmail/v1/users/me/drafts");
  });

  test("prefixes a Stripe host-absolute /v1 path the same way", () => {
    expect(rewriteOAuthProxyUpstreamPath("/v1/charges", STRIPE_SUB)).toBe(
      "/v1/oauth/proxy/stripe_link/v1/charges",
    );
  });

  test("leaves an already-prefixed path, including a different provider, alone", () => {
    expect(
      rewriteOAuthProxyUpstreamPath(
        "/v1/oauth/proxy/google/upload/gmail/v1/users/me/drafts",
        GOOGLE_SUB,
      ),
    ).toBe("/v1/oauth/proxy/google/upload/gmail/v1/users/me/drafts");
    expect(
      rewriteOAuthProxyUpstreamPath(
        "/v1/oauth/proxy/stripe_link/v1/charges",
        GOOGLE_SUB,
      ),
    ).toBe("/v1/oauth/proxy/stripe_link/v1/charges");
  });

  test("uses the pinned account segment when rewriting", () => {
    expect(
      rewriteOAuthProxyUpstreamPath(
        "/upload/gmail/v1/users/me/drafts",
        PINNED_SUB,
      ),
    ).toBe(
      "/v1/oauth/proxy/google@user%40example.com/upload/gmail/v1/users/me/drafts",
    );
  });

  test("does not resolve traversal or protocol-relative remainders", () => {
    expect(rewriteOAuthProxyUpstreamPath("/../v1/admin", GOOGLE_SUB)).toBe(
      "/v1/oauth/proxy/google/../v1/admin",
    );
    expect(rewriteOAuthProxyUpstreamPath("//evil.example/x", GOOGLE_SUB)).toBe(
      "/v1/oauth/proxy/google//evil.example/x",
    );
  });

  test("does not rewrite a non-grant subject", () => {
    expect(
      rewriteOAuthProxyUpstreamPath(
        "/upload/gmail/v1/users/me/drafts",
        "actor:self:user-123",
      ),
    ).toBe("/upload/gmail/v1/users/me/drafts");
  });
});
