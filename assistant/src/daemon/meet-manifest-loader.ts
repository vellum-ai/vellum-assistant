/**
 * `meet-manifest-loader` — registers proxy tools, routes, and shutdown
 * hooks for the meet-join skill from its shipped `manifest.json` without
 * loading the skill's source in-process. Paired with
 * {@link MeetHostSupervisor}, this is the lazy-external path that
 * eventually replaces `external-skills-bootstrap.ts` (PR 33).
 *
 * ## Lifecycle today (flag off)
 *
 * The `services.meet.host.lazy_external` config key defaults to `false`
 * (PR 32 flips it). When the flag is off, `external-skills-bootstrap.ts`
 * runs the in-process path (`register(createDaemonSkillHost("meet-join"))`)
 * and this loader is never invoked on main. Code lives here so PR 32
 * becomes a one-line default flip rather than a large rebase-prone patch.
 *
 * ## Lifecycle when the flag is on
 *
 * 1. The bootstrap constructs a {@link MeetHostSupervisor} and calls
 *    {@link setMeetHostSupervisorForSessionReports} so session-reporting
 *    IPC frames flow into the supervisor's counter.
 * 2. The bootstrap awaits `loadMeetManifestProxies(supervisor)` (this
 *    function). It reads the shipped `manifest.json`, builds a proxy
 *    `Tool` for every tool entry, a proxy `SkillRoute` for every route
 *    entry, and a shutdown hook for every declared hook name.
 * 3. Each proxy tool's `execute` and each proxy route handler call
 *    `supervisor.ensureRunning()` before attempting to dispatch over the
 *    skill IPC socket. Dispatch itself is implemented via the
 *    bidirectional skill IPC RPC: the proxy invokes
 *    `supervisor.dispatchTool` / `dispatchRoute` / `dispatchShutdown`,
 *    which sends a `skill.dispatch_*` frame to the meet-host child and
 *    awaits its response. Remote errors propagate to the LLM (for tools)
 *    or to the HTTP caller (for routes) as normal.
 *
 * ## Manifest path
 *
 * The manifest is expected at `<skillRuntimePath>/manifest.json` where
 * `skillRuntimePath` is resolved via
 * `getSkillRuntimePath("meet-join", getRepoSkillsDir())`. The loader
 * surfaces a clear error when the file is missing so packaging bugs
 * (manifest not shipped in the Docker image or `.app` Resources) fail
 * loudly at daemon startup rather than silently omitting the tools.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SkillRoute } from "../runtime/skill-route-registry.js";
import { registerSkillRoute } from "../runtime/skill-route-registry.js";
import { getRepoSkillsDir } from "../skills/catalog-install.js";
import { registerExternalTools } from "../tools/registry.js";
import type {
  ExecutionTarget,
  Tool,
  ToolContext,
  ToolDefinition,
} from "../tools/types.js";
import { RiskLevel } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { getSkillRuntimePath } from "../util/platform.js";
import type { MeetHostSupervisor } from "./meet-host-supervisor.js";
import { registerShutdownHook } from "./shutdown-registry.js";

const log = getLogger("meet-manifest-loader");

const MEET_SKILL_ID = "meet-join";

// ---------------------------------------------------------------------------
// Manifest shape — mirrors skills/meet-join/scripts/emit-manifest.ts
// ---------------------------------------------------------------------------

interface ManifestToolEntry {
  name: string;
  description: string;
  category: string;
  risk: string;
  input_schema: unknown;
}

interface ManifestRouteEntry {
  pattern: string;
  methods: string[];
}

interface Manifest {
  skill: string;
  tools: ManifestToolEntry[];
  routes: ManifestRouteEntry[];
  shutdownHooks: string[];
  sourceHash: string;
}

function coerceRiskLevel(value: string, toolName: string): RiskLevel {
  // Manifest `risk` is a serialized RiskLevel ("low" | "medium" | "high").
  const allowed: readonly string[] = ["low", "medium", "high"];
  if (!allowed.includes(value)) {
    throw new Error(
      `meet-manifest-loader: unknown risk level "${value}" on tool "${toolName}"`,
    );
  }
  return value as RiskLevel;
}

/**
 * Allowlist of {@link ToolContext} fields that survive JSON serialization
 * cleanly and that a remote skill might reasonably consult. Function /
 * AbortSignal / CesClient / proxy fields are intentionally excluded —
 * they cannot cross the IPC boundary.
 */
const SERIALIZABLE_TOOL_CONTEXT_KEYS = [
  "workingDir",
  "conversationId",
  "trustClass",
  "assistantId",
  "taskRunId",
  "requestId",
  "executionChannel",
  "callSessionId",
  "principal",
  "toolUseId",
  "memoryScopeId",
  "requesterExternalUserId",
  "requesterChatId",
  "requesterIdentifier",
  "requesterDisplayName",
  "transportInterface",
  "isInteractive",
  "isPlatformHosted",
] as const satisfies ReadonlyArray<keyof ToolContext>;

function serializeToolContext(context: ToolContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SERIALIZABLE_TOOL_CONTEXT_KEYS) {
    const value = context[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function buildProxyTool(
  entry: ManifestToolEntry,
  supervisor: MeetHostSupervisor,
  manifestHash: string,
): Tool {
  const definition: ToolDefinition = {
    name: entry.name,
    description: entry.description,
    input_schema: (entry.input_schema as object) ?? {},
  };
  const risk = coerceRiskLevel(entry.risk, entry.name);
  return {
    name: entry.name,
    description: entry.description,
    category: entry.category,
    defaultRiskLevel: risk,
    executionMode: "proxy",
    executionTarget: "host" as ExecutionTarget,
    origin: "skill",
    ownerSkillId: MEET_SKILL_ID,
    ownerSkillBundled: true,
    ownerSkillVersionHash: manifestHash,
    getDefinition: () => definition,
    execute: async (input, context) => {
      // `dispatchTool` ensures the meet-host child is up + connected
      // before sending the frame, so callers don't need a separate
      // `ensureRunning()` call. Remote errors propagate as normal.
      const result = await supervisor.dispatchTool(
        entry.name,
        input,
        serializeToolContext(context),
      );
      // The skill returns whatever its `Tool.execute` produced — the
      // daemon-side ToolExecutor expects `ToolExecutionResult` shape but
      // proxies forward verbatim; the LLM-facing executor reconciles the
      // shape downstream.
      return result as Awaited<ReturnType<Tool["execute"]>>;
    },
  };
}

function buildProxyRoute(
  entry: ManifestRouteEntry,
  supervisor: MeetHostSupervisor,
): SkillRoute {
  let pattern: RegExp;
  try {
    pattern = new RegExp(entry.pattern);
  } catch (err) {
    throw new Error(
      `meet-manifest-loader: invalid route pattern "${entry.pattern}": ${String(err)}`,
    );
  }
  return {
    pattern,
    methods: [...entry.methods],
    handler: async (request) => {
      let response: {
        status: number;
        headers: Record<string, string>;
        body: string;
      };
      try {
        // Materialize the inbound Request into a JSON-serializable
        // envelope: skill-side `dispatchRoute` reconstructs a fresh
        // `Request(url, init)` from this shape and runs the skill's
        // handler against it.
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const method = request.method;
        const body =
          method === "GET" || method === "HEAD"
            ? undefined
            : await request.text();
        response = await supervisor.dispatchRoute(entry.pattern, {
          method,
          url: request.url,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (err) {
        log.warn(
          { err, pattern: entry.pattern },
          "meet-host route dispatch failed",
        );
        return new Response("meet-host route dispatch failed", { status: 503 });
      }
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Locate the shipped manifest path. Visible for testing so callers can
 * redirect to a fixture without stubbing `getRepoSkillsDir()` (which
 * reads `import.meta.dir` and `process.env.VELLUM_DEV`).
 */
export function resolveMeetManifestPath(): string | undefined {
  const skillsRoot = getRepoSkillsDir();
  const skillRuntime = getSkillRuntimePath(MEET_SKILL_ID, skillsRoot);
  if (!skillRuntime) return undefined;
  return join(skillRuntime, "manifest.json");
}

/**
 * Read and validate the shipped manifest from disk. Exposed so
 * `external-skills-bootstrap.ts` can extract `sourceHash` for
 * {@link MeetHostSupervisor} construction without duplicating the JSON
 * validation shape.
 */
export function loadMeetManifestFromDisk(manifestPath: string): {
  skill: string;
  sourceHash: string;
  tools: ManifestToolEntry[];
  routes: ManifestRouteEntry[];
  shutdownHooks: string[];
} {
  return loadManifestInternal(manifestPath);
}

function loadManifestInternal(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `meet-join manifest not found at ${manifestPath} — ` +
        "rebuild/repackage to include the meet-join manifest " +
        "(skills/meet-join/scripts/emit-manifest.ts).",
    );
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `meet-join manifest at ${manifestPath} could not be read: ${String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `meet-join manifest at ${manifestPath} is not valid JSON: ${String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `meet-join manifest at ${manifestPath} must be a JSON object`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.skill !== MEET_SKILL_ID) {
    throw new Error(
      `meet-join manifest skill field was "${String(obj.skill)}" but expected "${MEET_SKILL_ID}"`,
    );
  }
  if (
    !Array.isArray(obj.tools) ||
    !Array.isArray(obj.routes) ||
    !Array.isArray(obj.shutdownHooks) ||
    typeof obj.sourceHash !== "string"
  ) {
    throw new Error(
      `meet-join manifest at ${manifestPath} is missing required fields`,
    );
  }
  return obj as unknown as Manifest;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Dependencies the loader reads to register manifest-derived proxies.
 * All fields are optional — production callers rely on the module-level
 * defaults and tests override one or two. Keeping them injectable lets
 * the unit test inject a fixture manifest path without mocking
 * `getRepoSkillsDir()` + `existsSync` + `readFileSync`.
 */
export interface MeetManifestLoaderDeps {
  /** Override for the manifest path resolver. */
  manifestPath?: string;
  /** Override for {@link registerExternalTools}. */
  registerTools?: (provider: () => Tool[]) => void;
  /** Override for {@link registerSkillRoute}. */
  registerRoute?: (route: SkillRoute) => unknown;
  /** Override for {@link registerShutdownHook}. */
  registerShutdown?: (
    name: string,
    hook: (reason: string) => Promise<void>,
  ) => void;
}

/**
 * Read the shipped manifest and install proxy tool/route/shutdown-hook
 * registrations that front-run through {@link MeetHostSupervisor}.
 * Throws when the manifest is missing or malformed so packaging errors
 * surface at daemon startup.
 */
export async function loadMeetManifestProxies(
  supervisor: MeetHostSupervisor,
  deps: MeetManifestLoaderDeps = {},
): Promise<void> {
  const manifestPath = deps.manifestPath ?? resolveMeetManifestPath();
  if (!manifestPath) {
    throw new Error(
      "meet-join manifest path is unresolved — " +
        "the shipped skills directory was not found. " +
        "Rebuild/repackage so first-party skills ship with the daemon.",
    );
  }
  const manifest = loadManifestInternal(manifestPath);

  const registerTools = deps.registerTools ?? registerExternalTools;
  const registerRoute = deps.registerRoute ?? registerSkillRoute;
  const registerShutdown = deps.registerShutdown ?? registerShutdownHook;

  // Tool provider resolves the full proxy list lazily so the tool manifest
  // reflects the manifest file at `initializeTools()` time — same timing
  // contract as the in-process skill's provider closure.
  registerTools(() =>
    manifest.tools.map((entry) =>
      buildProxyTool(entry, supervisor, manifest.sourceHash),
    ),
  );

  for (const entry of manifest.routes) {
    registerRoute(buildProxyRoute(entry, supervisor));
  }

  for (const hookName of manifest.shutdownHooks) {
    registerShutdown(hookName, async (reason) => {
      // Fire the named shutdown hook on the skill side so it runs any
      // teardown the in-process registration would have run. Best-effort:
      // if the connection is gone or the dispatch throws, the supervisor
      // still tears down the child below.
      try {
        await supervisor.dispatchShutdown(hookName, reason);
      } catch (err) {
        log.warn(
          { err, hookName, reason },
          "meet-host shutdown hook dispatch failed; continuing with supervisor teardown",
        );
      }
      await supervisor.shutdown();
    });
  }

  log.info(
    {
      manifestPath,
      tools: manifest.tools.length,
      routes: manifest.routes.length,
      shutdownHooks: manifest.shutdownHooks.length,
      sourceHash: manifest.sourceHash,
    },
    "Loaded meet-join manifest and installed lazy proxies",
  );
}
