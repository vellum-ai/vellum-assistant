/**
 * Tool Execution Pipeline Benchmark
 *
 * Measures the overhead of each phase in the permission/security pipeline:
 * 1. classifyRisk — risk classification
 * 2. check — trust rule matching (both no-rule fallback and matched-rule paths)
 * 3. scanText — secret scanning on output
 * 4. ToolExecutor.execute() — full pipeline overhead with noop/slow tools
 *
 * Target ranges:
 * - p50 pipeline overhead (classifyRisk + check) < 20ms for pre-approved tools
 * - p95 pipeline overhead < 50ms
 * - Overhead is constant regardless of tool execution time
 * - Secret scanning < 5ms for short outputs (< 1KB)
 * - Secret scanning < 50ms for large outputs (100KB)
 * - ToolExecutor overhead < 20ms regardless of tool execution time
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "tool-pipeline-bench-"));

// Local registry for ToolExecutor tests — the mock delegates to this map
// so that registerTool/getTool/getAllTools work for our benchmark tools.
const localRegistry = new Map<string, import("../tools/types.js").Tool>();

// Mocks must precede imports of modules under test.
mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getHooksDir: () => join(testDir, "hooks"),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Allow toggling between no-rule and matched-rule paths
let mockRuleResponse: import("../permissions/types.js").TrustRule | null = null;

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => mockRuleResponse,
  clearCache: () => {},
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    timeouts: { permissionTimeoutSec: 5, toolExecutionTimeoutSec: 120 },
    permissions: { mode: "workspace" },
    skills: { load: { extraDirs: [] } },
    secretDetection: { enabled: true, entropyThreshold: 4.0, action: "warn" },
    sandbox: { enabled: false },
    contextWindow: {},
    memory: {},
  }),
}));

mock.module("../config/skills.js", () => ({
  resolveSkillSelector: () => ({ skill: null }),
  loadSkillCatalog: () => [],
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => localRegistry.get(name),
  getAllTools: () => Array.from(localRegistry.values()),
  registerTool: (tool: import("../tools/types.js").Tool) => {
    localRegistry.set(tool.name, tool);
  },
}));

mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: () => Promise.resolve({ blocked: false }),
  }),
}));

import { check, classifyRisk } from "../permissions/checker.js";
import { PermissionPrompter } from "../permissions/prompter.js";
import { RiskLevel } from "../permissions/types.js";
import {
  DEFAULT_ENTROPY_CONFIG,
  scanText,
} from "../security/secret-scanner.js";
import { ToolExecutor } from "../tools/executor.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function benchmarkAsync<T>(
  fn: () => Promise<T>,
  iterations: number,
): Promise<{ timings: number[]; results: T[] }> {
  const timings: number[] = [];
  const results: T[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = await fn();
    timings.push(performance.now() - start);
    results.push(result);
  }
  return { timings, results };
}

function benchmarkSync<T>(
  fn: () => T,
  iterations: number,
): { timings: number[]; results: T[] } {
  const timings: number[] = [];
  const results: T[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = fn();
    timings.push(performance.now() - start);
    results.push(result);
  }
  return { timings, results };
}

function generateLargeOutput(sizeBytes: number): string {
  // Generate realistic-looking tool output with varied content
  const lines: string[] = [];
  const words = [
    "function",
    "const",
    "let",
    "return",
    "import",
    "export",
    "class",
    "interface",
    "type",
    "async",
    "await",
    "Promise",
    "string",
    "number",
    "boolean",
    "undefined",
    "null",
    "void",
  ];
  let currentSize = 0;
  while (currentSize < sizeBytes) {
    const lineWords: string[] = [];
    for (let w = 0; w < 10; w++) {
      lineWords.push(words[Math.floor(Math.random() * words.length)]);
    }
    const line = lineWords.join(" ");
    lines.push(line);
    currentSize += line.length + 1; // +1 for newline
  }
  return lines.join("\n").slice(0, sizeBytes);
}

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------

const ITERATIONS = 100;
const WARMUP = 5;

describe("Tool execution pipeline benchmark", () => {
  // Warm up the parser/modules
  beforeAll(async () => {
    for (let i = 0; i < WARMUP; i++) {
      await classifyRisk("file_read", { path: "/tmp/test.ts" }, "/tmp");
      await check("file_read", { path: "/tmp/test.ts" }, "/tmp");
      scanText("no secrets here");
    }
  });

  afterAll(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  test("classifyRisk: low-risk tool (file_read) is fast", async () => {
    const { timings } = await benchmarkAsync(
      () => classifyRisk("file_read", { path: "/tmp/test.ts" }, "/tmp"),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    expect(p50).toBeLessThan(5);
    expect(p95).toBeLessThan(10);
  });

  test("classifyRisk: bash command classification", async () => {
    const { timings, results } = await benchmarkAsync(
      () => classifyRisk("bash", { command: "ls -la /tmp" }, "/tmp"),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    // Bash classification involves shell parsing so it is slower
    expect(p50).toBeLessThan(15);
    expect(p95).toBeLessThan(40);
    // Verify correctness: ls should be low risk
    expect(results[0]).toBe(RiskLevel.Low);
  });

  test("classifyRisk: medium-risk tool (file_write)", async () => {
    const { timings, results } = await benchmarkAsync(
      () => classifyRisk("file_write", { path: "/tmp/out.txt" }, "/tmp"),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    expect(p50).toBeLessThan(5);
    expect(results[0]).toBe(RiskLevel.Medium);
  });

  test("check: full permission check for low-risk tool", async () => {
    const { timings, results } = await benchmarkAsync(
      () => check("file_read", { path: "/tmp/test.ts" }, "/tmp"),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    // Full check includes classifyRisk + trust rule lookup
    expect(p50).toBeLessThan(10);
    expect(p95).toBeLessThan(20);
    // Low-risk with no matching rule should auto-allow
    expect(results[0].decision).toBe("allow");
  });

  test("check: full permission check for bash command", async () => {
    const { timings, results } = await benchmarkAsync(
      () => check("bash", { command: "git status" }, "/tmp"),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    // Bash involves shell parsing + trust rule lookup
    expect(p50).toBeLessThan(20);
    expect(p95).toBeLessThan(50);
    // git status is low risk, should auto-allow
    expect(results[0].decision).toBe("allow");
  });

  test("check: matched allow-rule path for medium-risk tool", async () => {
    // Exercise the code path where findHighestPriorityRule returns a matching
    // allow rule, rather than always falling through to the no-rule default.
    mockRuleResponse = {
      id: "bench:allow-file_write",
      tool: "file_write",
      pattern: "**",
      scope: "/tmp",
      decision: "allow",
      priority: 90,
      createdAt: Date.now(),
    };

    try {
      const { timings, results } = await benchmarkAsync(
        () => check("file_write", { path: "/tmp/out.txt" }, "/tmp"),
        ITERATIONS,
      );

      const p50 = percentile(timings, 50);
      const p95 = percentile(timings, 95);

      expect(p50).toBeLessThan(10);
      expect(p95).toBeLessThan(20);
      // Medium-risk with a matching allow rule should auto-allow
      expect(results[0].decision).toBe("allow");
      expect(results[0].matchedRule?.id).toBe("bench:allow-file_write");
    } finally {
      mockRuleResponse = null;
    }
  });

  test("check: permission cost is stable across different input paths", async () => {
    // Verify that the permission check cost doesn't vary with input path length/complexity.
    // Actual tool-execution-time independence is tested in the ToolExecutor section below.
    const shortPathTimings: number[] = [];
    const longPathTimings: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const start1 = performance.now();
      await check("file_read", { path: "/tmp/fast.ts" }, "/tmp");
      shortPathTimings.push(performance.now() - start1);

      const start2 = performance.now();
      await check(
        "file_read",
        { path: "/tmp/slow-complex-deeply-nested-file.ts" },
        "/tmp",
      );
      longPathTimings.push(performance.now() - start2);
    }

    const shortP50 = percentile(shortPathTimings, 50);
    const longP50 = percentile(longPathTimings, 50);

    // Permission check cost should be roughly the same regardless of path length
    const ratio =
      Math.max(shortP50, longP50) /
      Math.max(Math.min(shortP50, longP50), 0.001);
    expect(ratio).toBeLessThan(5);
  });

  test("scanText: short output (< 1KB) completes quickly", () => {
    const shortOutput =
      "Build succeeded. 42 tests passed, 0 failed.\nTime: 1.23s";

    const { timings } = benchmarkSync(
      () => scanText(shortOutput, DEFAULT_ENTROPY_CONFIG),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    expect(p50).toBeLessThan(5);
    expect(p95).toBeLessThan(10);
  });

  test("scanText: large output (100KB) within budget", () => {
    const largeOutput = generateLargeOutput(100 * 1024);

    const { timings } = benchmarkSync(
      () => scanText(largeOutput, DEFAULT_ENTROPY_CONFIG),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    expect(p50).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
  });

  test("scanText: output with secrets is detected without excessive overhead", () => {
    // Build fake secrets programmatically to avoid pre-commit hook false positives
    const fakeGhToken = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const fakeConnStr =
      "postgres://" + "user:s3cret@db.host.example.com:5432/mydb";
    const outputWithSecrets = [
      "Deploying to production...",
      `Using API key: ${fakeGhToken}`,
      `Connection: ${fakeConnStr}`,
      "Build complete.",
    ].join("\n");

    const { timings, results } = benchmarkSync(
      () => scanText(outputWithSecrets, DEFAULT_ENTROPY_CONFIG),
      ITERATIONS,
    );

    const p50 = percentile(timings, 50);
    expect(p50).toBeLessThan(5);

    // Verify detection correctness
    expect(results[0].length).toBeGreaterThanOrEqual(2);
    const types = results[0].map((m) => m.type);
    expect(types).toContain("GitHub Token");
    expect(types).toContain("Database Connection String");
  });

  test("combined pipeline overhead (classifyRisk + check + scanText) stays under budget", async () => {
    const timings: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();

      // Phase 1: Risk classification
      await classifyRisk("bash", { command: "git diff HEAD" }, "/tmp");
      // Phase 2: Permission check
      await check("bash", { command: "git diff HEAD" }, "/tmp");
      // Phase 3: Secret scanning on output
      scanText(
        "diff --git a/file.ts b/file.ts\n+const x = 42;\n-const x = 41;",
        DEFAULT_ENTROPY_CONFIG,
      );

      timings.push(performance.now() - start);
    }

    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);

    // Combined pipeline overhead for a pre-approved tool
    expect(p50).toBeLessThan(20);
    expect(p95).toBeLessThan(50);
  });

  // -------------------------------------------------------------------------
  // ToolExecutor end-to-end overhead benchmarks
  // -------------------------------------------------------------------------

  describe("ToolExecutor overhead", () => {
    const SLEEP_MS = 50;
    // Fewer iterations for slow-tool tests to avoid timeouts (50ms * 30 = 1.5s)
    const SLOW_ITERATIONS = 30;
    let executor: ToolExecutor;
    const toolContext: ToolContext = {
      workingDir: "/tmp",
      conversationId: "bench-conv",
      trustClass: "guardian",
    };

    function makeTool(name: string, sleepMs: number): Tool {
      return {
        name,
        description: `Benchmark tool (${sleepMs}ms)`,
        category: "benchmark",
        defaultRiskLevel: RiskLevel.Low,
        getDefinition: () => ({
          name,
          description: `Benchmark tool (${sleepMs}ms)`,
          input_schema: { type: "object" as const, properties: {} },
        }),
        execute: async (): Promise<ToolExecutionResult> => {
          if (sleepMs > 0) {
            await new Promise((r) => setTimeout(r, sleepMs));
          }
          return { content: "ok", isError: false };
        },
      };
    }

    beforeAll(() => {
      // Auto-allow prompter (never called for low-risk tools, but required by constructor)
      const prompter = new PermissionPrompter(() => {});
      executor = new ToolExecutor(prompter);

      const noopTool = makeTool("bench_noop", 0);
      const slowTool = makeTool("bench_slow", SLEEP_MS);
      localRegistry.set(noopTool.name, noopTool);
      localRegistry.set(slowTool.name, slowTool);
    });

    test("ToolExecutor with noop tool: pipeline overhead < 20ms", async () => {
      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        await executor.execute("bench_noop", {}, toolContext);
      }

      const { timings } = await benchmarkAsync(
        () => executor.execute("bench_noop", {}, toolContext),
        ITERATIONS,
      );

      const p50 = percentile(timings, 50);
      const p95 = percentile(timings, 95);

      // Full pipeline overhead for a noop tool should be minimal
      expect(p50).toBeLessThan(20);
      expect(p95).toBeLessThan(50);
    });

    test("ToolExecutor with slow tool (50ms): overhead is constant", async () => {
      // Warmup
      for (let i = 0; i < WARMUP; i++) {
        await executor.execute("bench_slow", {}, toolContext);
      }

      const { timings } = await benchmarkAsync(
        () => executor.execute("bench_slow", {}, toolContext),
        SLOW_ITERATIONS,
      );

      const p50 = percentile(timings, 50);

      // Total time should be ~50ms + overhead. Pipeline overhead (total - sleep)
      // should be similar to the noop case.
      expect(p50).toBeGreaterThanOrEqual(SLEEP_MS);
      // Total should not exceed sleep + generous overhead budget
      expect(p50).toBeLessThan(SLEEP_MS + 30);
    }, 10_000);

    test("overhead subtraction: slow tool overhead matches noop overhead", async () => {
      // Run both tools and compare pipeline overhead
      const noopTimings: number[] = [];
      const slowTimings: number[] = [];

      for (let i = 0; i < SLOW_ITERATIONS; i++) {
        const s1 = performance.now();
        await executor.execute("bench_noop", {}, toolContext);
        noopTimings.push(performance.now() - s1);

        const s2 = performance.now();
        await executor.execute("bench_slow", {}, toolContext);
        slowTimings.push(performance.now() - s2);
      }

      const noopP50 = percentile(noopTimings, 50);
      const slowP50 = percentile(slowTimings, 50);

      // Overhead = slow_duration - sleep_time. Should be close to noop_duration.
      const slowOverhead = slowP50 - SLEEP_MS;

      // The overhead portion of the slow tool should be within 10ms of the noop total
      expect(Math.abs(slowOverhead - noopP50)).toBeLessThan(10);
    }, 10_000);
  });
});
