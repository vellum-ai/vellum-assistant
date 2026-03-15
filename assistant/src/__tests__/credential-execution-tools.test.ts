import { describe, expect, test } from "bun:test";

import { RiskLevel } from "../permissions/types.js";
import { makeAuthenticatedRequestTool } from "../tools/credential-execution/make-authenticated-request.js";
import { manageSecureCommandTool } from "../tools/credential-execution/manage-secure-command-tool.js";
import { runAuthenticatedCommandTool } from "../tools/credential-execution/run-authenticated-command.js";
import { cesTools, getCesToolsIfEnabled } from "../tools/tool-manifest.js";
import type { Tool } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Schema shape tests
// ---------------------------------------------------------------------------

describe("CES tool schema shapes", () => {
  test("make_authenticated_request has correct name and required fields", () => {
    const def = makeAuthenticatedRequestTool.getDefinition();
    expect(def.name).toBe("make_authenticated_request");
    const schema = def.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("credentialHandle");
    expect(schema.required).toContain("method");
    expect(schema.required).toContain("url");
    expect(schema.required).toContain("purpose");
    // Should include optional grantId for re-use of prior approvals
    expect(schema.properties).toHaveProperty("grantId");
  });

  test("run_authenticated_command has correct name and required fields", () => {
    const def = runAuthenticatedCommandTool.getDefinition();
    expect(def.name).toBe("run_authenticated_command");
    const schema = def.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("credentialHandle");
    expect(schema.required).toContain("command");
    expect(schema.required).toContain("purpose");
    // Should include optional fields
    expect(schema.properties).toHaveProperty("cwd");
    expect(schema.properties).toHaveProperty("grantId");
  });

  test("manage_secure_command_tool has correct name and required fields", () => {
    const def = manageSecureCommandTool.getDefinition();
    expect(def.name).toBe("manage_secure_command_tool");
    const schema = def.input_schema as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("action");
    expect(schema.required).toContain("toolName");
    // Bundle metadata fields must be exposed for guardian review
    expect(schema.properties).toHaveProperty("bundleId");
    expect(schema.properties).toHaveProperty("version");
    expect(schema.properties).toHaveProperty("sourceUrl");
    expect(schema.properties).toHaveProperty("sha256");
    expect(schema.properties).toHaveProperty("secureCommandManifest");
  });

  test("all CES tools are high risk", () => {
    for (const tool of cesTools) {
      expect(tool.defaultRiskLevel).toBe(RiskLevel.High);
    }
  });

  test("all CES tools belong to credential-execution category", () => {
    for (const tool of cesTools) {
      expect(tool.category).toBe("credential-execution");
    }
  });
});

// ---------------------------------------------------------------------------
// Tool manifest / registration tests
// ---------------------------------------------------------------------------

describe("CES tool manifest registration", () => {
  test("cesTools contains exactly three CES tools", () => {
    expect(cesTools).toHaveLength(3);
    const names = cesTools.map((t: Tool) => t.name);
    expect(names).toContain("make_authenticated_request");
    expect(names).toContain("run_authenticated_command");
    expect(names).toContain("manage_secure_command_tool");
  });

  test("getCesToolsIfEnabled returns empty when flag is disabled", () => {
    // The CES feature flag defaults to disabled in the registry
    // (defaultEnabled: false), so without an explicit override
    // getCesToolsIfEnabled should return an empty array.
    const tools = getCesToolsIfEnabled();
    expect(tools).toHaveLength(0);
  });

  test("no CES tool exposes raw secret values in its schema", () => {
    for (const tool of cesTools) {
      const def = tool.getDefinition();
      const schema = def.input_schema as {
        properties: Record<string, { type?: string; description?: string }>;
      };
      // No field should accept a secret/password/token value directly
      for (const [key, prop] of Object.entries(schema.properties)) {
        const desc = (prop.description ?? "").toLowerCase();
        expect(key === "value" && desc.includes("secret")).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Secure tool installation separation tests
// ---------------------------------------------------------------------------

describe("secure tool installation is separate from credential grants", () => {
  test("manage_secure_command_tool accepts only bundle metadata, not raw bytes", () => {
    const def = manageSecureCommandTool.getDefinition();
    const schema = def.input_schema as {
      properties: Record<string, unknown>;
    };
    const propertyNames = Object.keys(schema.properties);
    // Must NOT have fields for raw content or file paths
    expect(propertyNames).not.toContain("content");
    expect(propertyNames).not.toContain("bytes");
    expect(propertyNames).not.toContain("filePath");
    expect(propertyNames).not.toContain("workspacePath");
    expect(propertyNames).not.toContain("data");
    // Must have the user-reviewable metadata fields
    expect(propertyNames).toContain("bundleId");
    expect(propertyNames).toContain("version");
    expect(propertyNames).toContain("sourceUrl");
    expect(propertyNames).toContain("sha256");
  });

  test("manage_secure_command_tool does not share tool name with grant tools", () => {
    // The tool name must not collide with existing credential grant tools
    const grantToolNames = [
      "credential_store",
      "credential_grant",
      "credential_revoke",
      "credential_list",
    ];
    expect(grantToolNames).not.toContain(manageSecureCommandTool.name);
  });

  test("manage_secure_command_tool action enum does not include grant actions", () => {
    const def = manageSecureCommandTool.getDefinition();
    const schema = def.input_schema as {
      properties: {
        action: { enum?: string[] };
      };
    };
    const actionEnum = schema.properties.action.enum ?? [];
    // Should only have register/unregister, not grant-related actions
    expect(actionEnum).toEqual(["register", "unregister"]);
    expect(actionEnum).not.toContain("grant");
    expect(actionEnum).not.toContain("revoke");
  });
});

// ---------------------------------------------------------------------------
// Execution tests (CES client not available)
// ---------------------------------------------------------------------------

describe("CES tool execution without client", () => {
  const minimalContext = {
    workingDir: "/tmp",
    sessionId: "test-session",
    conversationId: "test-conversation",
    trustClass: "guardian" as const,
  };

  test("make_authenticated_request fails gracefully when CES client is absent", async () => {
    const result = await makeAuthenticatedRequestTool.execute(
      {
        credentialHandle: "local_static:test/key",
        method: "GET",
        url: "https://example.com",
        purpose: "test",
      },
      minimalContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("CES client is not available");
  });

  test("run_authenticated_command fails gracefully when CES client is absent", async () => {
    const result = await runAuthenticatedCommandTool.execute(
      {
        credentialHandle: "local_static:test/key",
        command: "echo hello",
        purpose: "test",
      },
      minimalContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("CES client is not available");
  });

  test("manage_secure_command_tool fails gracefully when CES client is absent", async () => {
    const result = await manageSecureCommandTool.execute(
      {
        action: "register",
        toolName: "test-tool",
        bundleId: "test-bundle",
        version: "1.0.0",
        sourceUrl: "https://example.com/bundle.tar.gz",
        sha256: "abc123",
        credentialHandle: "local_static:test/key",
      },
      minimalContext,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("CES client is not available");
  });
});

// ---------------------------------------------------------------------------
// manage_secure_command_tool input validation tests
// ---------------------------------------------------------------------------

describe("manage_secure_command_tool input validation", () => {
  const contextWithMockCes = {
    workingDir: "/tmp",
    sessionId: "test-session",
    conversationId: "test-conversation",
    trustClass: "guardian" as const,
    cesClient: {
      isReady: () => true,
      handshake: async () => ({ accepted: true }),
      call: async () => ({ success: true }),
      close: () => {},
    },
  };

  test("rejects register without required bundle metadata", async () => {
    const result = await manageSecureCommandTool.execute(
      {
        action: "register",
        toolName: "test-tool",
        // Missing bundleId, version, sourceUrl, sha256, credentialHandle
      },
      contextWithMockCes,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("bundleId");
    expect(result.content).toContain("version");
    expect(result.content).toContain("sourceUrl");
    expect(result.content).toContain("sha256");
    expect(result.content).toContain("credentialHandle");
  });

  test("rejects non-HTTPS sourceUrl", async () => {
    const result = await manageSecureCommandTool.execute(
      {
        action: "register",
        toolName: "test-tool",
        bundleId: "test-bundle",
        version: "1.0.0",
        sourceUrl: "http://insecure.example.com/bundle.tar.gz",
        sha256: "abc123",
        credentialHandle: "local_static:test/key",
        description: "test tool",
        secureCommandManifest: {
          schemaVersion: "1",
          bundleDigest: "abc123",
          bundleId: "test-bundle",
          version: "1.0.0",
          entrypoint: "bin/test",
          commandProfiles: {},
          authAdapter: { type: "env_var", envVarName: "TEST_TOKEN" },
          egressMode: "no_network",
        },
      },
      contextWithMockCes,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("HTTPS");
  });
});
