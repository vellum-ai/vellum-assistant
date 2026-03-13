import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { CredentialBroker } from "../tools/credentials/broker.js";
import {
  _setMetadataPath,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

describe("CredentialBroker", () => {
  let broker: CredentialBroker;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "broker-test-"));
    _setMetadataPath(join(tmpDir, "metadata.json"));
    broker = new CredentialBroker();
  });

  afterEach(() => {
    _setMetadataPath(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("authorize", () => {
    test("denies when no credential metadata exists", () => {
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("No credential found");
      }
    });

    test("authorizes when tool is in allowedTools", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(true);
      if (result.authorized) {
        expect(result.token.service).toBe("github");
        expect(result.token.field).toBe("token");
        expect(result.token.toolName).toBe("browser_fill_credential");
        expect(result.token.consumed).toBe(false);
        expect(result.token.tokenId).toBeTruthy();
      }
    });

    test("denies when tool is not in allowedTools", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["other_tool"],
      });
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("not allowed");
        expect(result.reason).toContain("browser_fill_credential");
        expect(result.reason).toContain("Allowed tools: other_tool");
      }
    });

    test("denies when allowedTools is empty (fail-closed)", () => {
      upsertCredentialMetadata("github", "token");
      const result = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toContain("not allowed");
        expect(result.reason).toContain("No tools are currently allowed");
        expect(result.reason).toContain("credential_store");
      }
    });

    test("issues unique token IDs", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["tool1", "tool2"],
      });
      const r1 = broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool1",
      });
      const r2 = broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool2",
      });
      expect(r1.authorized).toBe(true);
      expect(r2.authorized).toBe(true);
      if (r1.authorized && r2.authorized) {
        expect(r1.token.tokenId).not.toBe(r2.token.tokenId);
      }
    });
  });

  describe("consume", () => {
    test("returns storage key on first consumption", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const auth = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      expect(auth.authorized).toBe(true);
      if (!auth.authorized) return;

      const result = broker.consume(auth.token.tokenId);
      expect(result.success).toBe(true);
      expect(result.storageKey).toBe(credentialKey("github", "token"));
    });

    test("rejects double consumption", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const auth = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      if (!auth.authorized) return;

      broker.consume(auth.token.tokenId);
      const result = broker.consume(auth.token.tokenId);
      expect(result.success).toBe(false);
      expect(result.reason).toContain("already consumed");
    });

    test("rejects unknown token ID", () => {
      const result = broker.consume("nonexistent-token");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("not found");
    });
  });

  describe("revoke", () => {
    test("revokes existing token", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });
      const auth = broker.authorize({
        service: "github",
        field: "token",
        toolName: "browser_fill_credential",
      });
      if (!auth.authorized) return;

      expect(broker.revoke(auth.token.tokenId)).toBe(true);
      // After revocation, consume should fail
      const result = broker.consume(auth.token.tokenId);
      expect(result.success).toBe(false);
    });

    test("returns false for unknown token", () => {
      expect(broker.revoke("nonexistent")).toBe(false);
    });
  });

  describe("revokeAll", () => {
    test("clears all active tokens", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["tool1", "tool2"],
      });
      broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool1",
      });
      broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool2",
      });
      expect(broker.activeTokenCount).toBe(2);

      broker.revokeAll();
      expect(broker.activeTokenCount).toBe(0);
    });
  });

  describe("activeTokenCount", () => {
    test("counts only unconsumed tokens", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["tool1", "tool2"],
      });
      const auth1 = broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool1",
      });
      broker.authorize({
        service: "github",
        field: "token",
        toolName: "tool2",
      });
      expect(broker.activeTokenCount).toBe(2);

      if (auth1.authorized) {
        broker.consume(auth1.token.tokenId);
      }
      expect(broker.activeTokenCount).toBe(1);
    });
  });
});
