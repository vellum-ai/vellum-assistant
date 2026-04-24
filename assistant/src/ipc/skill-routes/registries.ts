/**
 * Skill IPC routes — `host.registries.*` surface.
 *
 * Lets an out-of-process skill install tools, HTTP routes, shutdown hooks
 * and session-tracking signals into the daemon's in-memory registries. The
 * register_* routes install proxy entries whose behavior ultimately dispatches
 * back over the same IPC socket via `skill.dispatch_*` calls; those
 * reverse-direction dispatch paths are PR 28's concern, so the proxies here
 * install `execute` / handler / hook stubs that throw a "not implemented —
 * dispatch added in PR 28" error. The shape of the registration (name,
 * description, risk level, execution target, regex, methods) is what matters
 * for this PR — downstream PRs only need to swap the stub body for a real
 * `skill.dispatch_*` round-trip.
 *
 * `report_session_started` / `report_session_ended` keep an internal counter
 * the PR 27 `MeetHostSupervisor` reads. Until that supervisor lands the
 * counter lives in this module — PR 27 replaces the helper without changing
 * the IPC wire contract.
 */

import { z } from "zod";

import type { MeetHostSupervisor } from "../../daemon/meet-host-supervisor.js";
import { registerShutdownHook } from "../../daemon/shutdown-registry.js";
import { registerSkillRoute } from "../../runtime/skill-route-registry.js";
import { registerSkillTools } from "../../tools/registry.js";
import type {
  ExecutionTarget,
  Tool,
  ToolDefinition,
} from "../../tools/types.js";
import { RiskLevel } from "../../tools/types.js";
import { getLogger } from "../../util/logger.js";
import type { IpcRoute } from "../cli-server.js";
import type { SkillIpcConnection } from "../skill-server.js";

const log = getLogger("skill-routes-registries");

// ── Wire-level schemas ────────────────────────────────────────────────

/**
 * Serialized tool manifest entry sent over IPC. Mirrors the subset of
 * {@link Tool} a skill process can describe without carrying the tool's
 * executable closure across the socket; the closure is synthesized
 * daemon-side (see {@link buildProxyTool}) to forward invocations back
 * over IPC.
 */
const ToolManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  defaultRiskLevel: z.enum(["low", "medium", "high"]),
  category: z.string().min(1),
  executionTarget: z.enum(["sandbox", "host"]).optional(),
  executionMode: z.enum(["local", "proxy"]).optional(),
  ownerSkillId: z.string().optional(),
  ownerSkillBundled: z.boolean().optional(),
  ownerSkillVersionHash: z.string().optional(),
});

export type ToolManifest = z.infer<typeof ToolManifestSchema>;

const RegisterToolsParams = z.object({
  tools: z.array(ToolManifestSchema).min(1),
});

const RegisterSkillRouteParams = z.object({
  patternSource: z.string().min(1),
  // `new RegExp(patternSource)` alone silently drops i/m/g/s/u/y flags from
  // the skill-side RegExp — keep them as a separate field to survive IPC.
  patternFlags: z.string().default(""),
  methods: z.array(z.string().min(1)).min(1),
  skillId: z.string().min(1).optional(),
});

const RegisterShutdownHookParams = z.object({
  name: z.string().min(1),
});

const ReportSessionParams = z.object({
  meetingId: z.string().min(1),
});

// ── Session counter ───────────────────────────────────────────────────

/**
 * Fallback active-session set. Keyed by meetingId so duplicate
 * `report_session_started` calls are idempotent and `report_session_ended`
 * for an unknown id is a no-op. Used when no {@link MeetHostSupervisor}
 * has been registered (e.g. when the lazy-external flag is off, in the
 * narrow window before `external-skills-bootstrap.ts` runs, and in tests
 * that exercise the IPC routes in isolation). Also backs the test-only
 * peek helper since the supervisor owns its own counter.
 */
const activeSessions = new Set<string>();

/**
 * Optional supervisor injected by `external-skills-bootstrap.ts` when the
 * lazy-external path is enabled. When set, IPC session-report frames are
 * forwarded to it so its active-session counter and idle-shutdown timer
 * stay in sync with the routes. When unset, the fallback set above is
 * mutated directly.
 */
type SessionSupervisor = Pick<
  MeetHostSupervisor,
  "reportSessionStarted" | "reportSessionEnded" | "activeSessionCount"
>;

let sessionSupervisor: SessionSupervisor | null = null;

/**
 * Install a {@link MeetHostSupervisor} as the session-report sink. The IPC
 * routes still maintain their fallback {@link Set} for diagnostics, but
 * the supervisor's counter is the source of truth for the `activeCount`
 * returned to the skill. Passing `null` detaches the supervisor — used
 * by tests that want to exercise the fallback path cleanly.
 */
export function setMeetHostSupervisorForSessionReports(
  supervisor: SessionSupervisor | null,
): void {
  sessionSupervisor = supervisor;
}

function reportSessionStarted(meetingId: string): number {
  if (sessionSupervisor) {
    sessionSupervisor.reportSessionStarted(meetingId);
    const count = sessionSupervisor.activeSessionCount;
    log.info(
      { meetingId, activeCount: count },
      "Skill reported session started",
    );
    return count;
  }
  activeSessions.add(meetingId);
  log.info(
    { meetingId, activeCount: activeSessions.size },
    "Skill reported session started",
  );
  return activeSessions.size;
}

function reportSessionEnded(meetingId: string): number {
  if (sessionSupervisor) {
    sessionSupervisor.reportSessionEnded(meetingId);
    const count = sessionSupervisor.activeSessionCount;
    log.info({ meetingId, activeCount: count }, "Skill reported session ended");
    return count;
  }
  activeSessions.delete(meetingId);
  log.info(
    { meetingId, activeCount: activeSessions.size },
    "Skill reported session ended",
  );
  return activeSessions.size;
}

/** Test-only: drop all active sessions between test cases. */
export function __resetActiveSessionsForTesting(): void {
  activeSessions.clear();
  sessionSupervisor = null;
}

/** Test-only: peek at the current active set size. */
export function __getActiveSessionCountForTesting(): number {
  return activeSessions.size;
}

// ── Proxy-tool construction ───────────────────────────────────────────

/**
 * Build a daemon-side {@link Tool} whose `execute` routes back to the
 * remote skill over IPC. PR 28 replaces the stub body with a real
 * `skill.dispatch_tool` round-trip; until then we keep a shape-complete
 * proxy in the registry so the rest of the tool-manifest plumbing can be
 * exercised end-to-end.
 */
function buildProxyTool(manifest: ToolManifest): Tool {
  const definition: ToolDefinition = {
    name: manifest.name,
    description: manifest.description,
    input_schema: manifest.input_schema as object,
  };
  // RiskLevel is a string enum whose values are "low" | "medium" | "high",
  // matching the schema above exactly — the cast is a no-op at runtime.
  return {
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    defaultRiskLevel: manifest.defaultRiskLevel as RiskLevel,
    executionMode: manifest.executionMode ?? "proxy",
    executionTarget: manifest.executionTarget as ExecutionTarget | undefined,
    origin: "skill",
    ownerSkillId: manifest.ownerSkillId,
    ownerSkillBundled: manifest.ownerSkillBundled,
    ownerSkillVersionHash: manifest.ownerSkillVersionHash,
    getDefinition: () => definition,
    execute: async () => {
      throw new Error(
        `Skill tool "${manifest.name}" invocation not implemented — dispatch added in PR 28`,
      );
    },
  };
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleRegisterTools(
  params: Record<string, unknown> | undefined,
  connection?: unknown,
): Promise<{ registered: string[] }> {
  const { tools } = RegisterToolsParams.parse(params);
  const proxies = tools.map(buildProxyTool);
  // `registerExternalTools` is only consumed inside `initializeTools()` at
  // daemon boot; IPC children connect after boot, so route through
  // `registerSkillTools` into the live registry the agent-loop reads from.
  const accepted = registerSkillTools(proxies);

  const conn = connection as SkillIpcConnection | undefined;
  if (conn) {
    const ownerIds = new Set<string>();
    for (const tool of accepted) {
      if (tool.ownerSkillId) ownerIds.add(tool.ownerSkillId);
    }
    for (const skillId of ownerIds) {
      conn.addSkillToolsOwner(skillId);
    }
  }

  log.info(
    { count: accepted.length, names: accepted.map((t) => t.name) },
    "Registered skill proxy tools via IPC",
  );
  return { registered: accepted.map((t) => t.name) };
}

async function handleRegisterSkillRoute(
  params: Record<string, unknown> | undefined,
  connection?: unknown,
): Promise<{ patternSource: string; methods: string[] }> {
  const { patternSource, patternFlags, methods, skillId } =
    RegisterSkillRouteParams.parse(params);
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternSource, patternFlags);
  } catch (err) {
    throw new Error(
      `Invalid skill-route pattern "${patternSource}" (flags "${patternFlags}"): ${String(err)}`,
    );
  }
  const handle = registerSkillRoute({
    pattern,
    methods,
    handler: async () => {
      // PR 28 replaces this stub with a `skill.dispatch_route` round-trip
      // that marshals the Request across the IPC socket and materializes
      // the Response back on the daemon side.
      return new Response(
        "Skill route dispatch not implemented — added in PR 28",
        { status: 501 },
      );
    },
  });
  // Retain the handle on the connection so disconnect revokes this route;
  // without it, reconnects accumulate routes with no owner to unregister them.
  const conn = connection as SkillIpcConnection | undefined;
  conn?.addRouteHandle(skillId ?? conn.connectionId, handle);

  log.info(
    { patternSource, patternFlags, methods, skillId },
    "Registered skill proxy HTTP route via IPC",
  );
  return { patternSource, methods };
}

async function handleRegisterShutdownHook(
  params?: Record<string, unknown>,
): Promise<{ name: string }> {
  const { name } = RegisterShutdownHookParams.parse(params);
  registerShutdownHook(name, async (reason) => {
    // PR 28 replaces this stub with a `skill.shutdown` dispatch that
    // delivers the reason string to the out-of-process skill and awaits
    // its teardown before returning.
    log.info(
      { name, reason },
      "Skill shutdown hook fired (dispatch stub — added in PR 28)",
    );
  });
  return { name };
}

async function handleReportSessionStarted(
  params?: Record<string, unknown>,
): Promise<{ activeCount: number }> {
  const { meetingId } = ReportSessionParams.parse(params);
  return { activeCount: reportSessionStarted(meetingId) };
}

async function handleReportSessionEnded(
  params?: Record<string, unknown>,
): Promise<{ activeCount: number }> {
  const { meetingId } = ReportSessionParams.parse(params);
  return { activeCount: reportSessionEnded(meetingId) };
}

// ── Route exports ─────────────────────────────────────────────────────

export const registerToolsRoute: IpcRoute = {
  method: "host.registries.register_tools",
  handler: handleRegisterTools,
};

export const registerSkillRouteRoute: IpcRoute = {
  method: "host.registries.register_skill_route",
  handler: handleRegisterSkillRoute,
};

export const registerShutdownHookRoute: IpcRoute = {
  method: "host.registries.register_shutdown_hook",
  handler: handleRegisterShutdownHook,
};

export const reportSessionStartedRoute: IpcRoute = {
  method: "host.registries.report_session_started",
  handler: handleReportSessionStarted,
};

export const reportSessionEndedRoute: IpcRoute = {
  method: "host.registries.report_session_ended",
  handler: handleReportSessionEnded,
};

export const registriesRoutes: IpcRoute[] = [
  registerToolsRoute,
  registerSkillRouteRoute,
  registerShutdownHookRoute,
  reportSessionStartedRoute,
  reportSessionEndedRoute,
];
