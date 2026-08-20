import { describe, expect, test } from "bun:test";

import type { CredentialMetadata } from "../tools/credentials/metadata-store.js";
import {
  BROWSER_FILL_CAPABILITY,
  isToolAllowed,
  serverUseDenialReason,
} from "../tools/credentials/tool-policy.js";

describe("isToolAllowed", () => {
  // ── Allow cases ─────────────────────────────────────────────────────

  test("allows tool listed in allowedTools", () => {
    expect(
      isToolAllowed("browser_fill_credential", ["browser_fill_credential"]),
    ).toBe(true);
  });

  test("allows tool when multiple tools are listed", () => {
    expect(
      isToolAllowed("bash", ["browser_fill_credential", "bash", "web_fetch"]),
    ).toBe(true);
  });

  // ── Deny cases ──────────────────────────────────────────────────────

  test("denies tool not in allowedTools", () => {
    expect(isToolAllowed("bash", ["browser_fill_credential"])).toBe(false);
  });

  test("denies when allowedTools is empty", () => {
    expect(isToolAllowed("browser_fill_credential", [])).toBe(false);
  });

  test("denies when allowedTools is undefined", () => {
    expect(
      isToolAllowed(
        "browser_fill_credential",
        undefined as unknown as string[],
      ),
    ).toBe(false);
  });

  test("denies when allowedTools is a string (not an array)", () => {
    expect(
      isToolAllowed("b", "browser_fill_credential" as unknown as string[]),
    ).toBe(false);
  });

  test("denies when toolName is empty", () => {
    expect(isToolAllowed("", ["browser_fill_credential"])).toBe(false);
  });

  test("denies when toolName is not a string", () => {
    expect(
      isToolAllowed(null as unknown as string, ["browser_fill_credential"]),
    ).toBe(false);
  });

  // ── Exact match (no wildcards) ──────────────────────────────────────

  test("requires exact match — no prefix matching", () => {
    expect(isToolAllowed("browser_fill", ["browser_fill_credential"])).toBe(
      false,
    );
  });

  test("requires exact match — no suffix matching", () => {
    expect(
      isToolAllowed("browser_fill_credential_v2", ["browser_fill_credential"]),
    ).toBe(false);
  });

  test("match is case-sensitive", () => {
    expect(
      isToolAllowed("Browser_Fill_Credential", ["browser_fill_credential"]),
    ).toBe(false);
  });
});

describe("serverUseDenialReason", () => {
  function metadata(
    overrides: Partial<CredentialMetadata> = {},
  ): CredentialMetadata {
    return {
      credentialId: "cred-1",
      service: "acp",
      field: "claude_oauth_token",
      allowedTools: ["acp_spawn"],
      allowedDomains: [],
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    };
  }

  test("denies when metadata is missing", () => {
    expect(
      serverUseDenialReason(
        undefined,
        "acp_spawn",
        "acp",
        "claude_oauth_token",
      ),
    ).toBe("No credential found for acp/claude_oauth_token");
  });

  test("denies fail-closed when allowedTools is empty", () => {
    const reason = serverUseDenialReason(
      metadata({ allowedTools: [] }),
      "acp_spawn",
      "acp",
      "claude_oauth_token",
    );
    expect(reason).toContain(
      'Tool "acp_spawn" is not allowed to use credential acp/claude_oauth_token.',
    );
    expect(reason).toContain("No tools are currently allowed");
  });

  test("denies when allowedTools omits the requesting tool", () => {
    const reason = serverUseDenialReason(
      metadata({ allowedTools: ["bash", "web_fetch"] }),
      "acp_spawn",
      "acp",
      "claude_oauth_token",
    );
    expect(reason).toContain(
      'Tool "acp_spawn" is not allowed to use credential acp/claude_oauth_token.',
    );
    expect(reason).toContain("Allowed tools: bash, web_fetch.");
  });

  test("allows when a legacy alias canonicalizes to the requesting tool", () => {
    expect(
      serverUseDenialReason(
        metadata({ allowedTools: ["browser_fill_credential"] }),
        BROWSER_FILL_CAPABILITY,
        "acp",
        "claude_oauth_token",
      ),
    ).toBeUndefined();
  });

  test("denies a domain-restricted credential", () => {
    expect(
      serverUseDenialReason(
        metadata({ allowedDomains: ["example.com", "example.org"] }),
        "acp_spawn",
        "acp",
        "claude_oauth_token",
      ),
    ).toBe(
      "Credential acp/claude_oauth_token has domain restrictions " +
        "(example.com, example.org) and cannot be used server-side. " +
        "Remove domain restrictions or use a separate credential without domain policy.",
    );
  });

  test("allows fully-permitted metadata", () => {
    expect(
      serverUseDenialReason(
        metadata(),
        "acp_spawn",
        "acp",
        "claude_oauth_token",
      ),
    ).toBeUndefined();
  });
});
