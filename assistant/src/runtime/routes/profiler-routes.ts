/**
 * Route handlers for managed profiler run management.
 *
 * Control-plane callers (proxied via vembda) can enumerate, inspect, export,
 * and delete completed profiler runs without opening a shell on the assistant
 * pod.
 *
 * Routes:
 *   GET    /v1/profiler/runs              — list all profiler runs
 *   GET    /v1/profiler/runs/:runId       — detail for a single run
 *   POST   /v1/profiler/runs/:runId/export — tar.gz export of a single run
 *   DELETE /v1/profiler/runs/:runId       — delete a completed run
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  getProfilerMaxBytes,
  getProfilerRunId,
} from "../../config/env-registry.js";
import {
  rescanRuns,
  runProfilerSweep,
} from "../../daemon/profiler-run-store.js";
import { getLogger } from "../../util/logger.js";
import { getProfilerRunDir } from "../../util/platform.js";
import { createTarGz, MAX_ARCHIVE_BYTES } from "./archive-utils.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  RouteError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("profiler-routes");

// ── Helpers ────────────────────────────────────────────────────────────

function readProfileSummary(runDir: string): string | undefined {
  try {
    const entries = readdirSync(runDir);
    const mdFile = entries.find((e) => e.endsWith(".md"));
    if (!mdFile) return undefined;
    return readFileSync(join(runDir, mdFile), "utf-8");
  } catch {
    return undefined;
  }
}

function validateRunId(runId: string | undefined): string {
  if (!runId) throw new BadRequestError("runId is required");
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    throw new BadRequestError("Invalid run ID");
  }
  return runId;
}

// ── Route handlers ─────────────────────────────────────────────────────

/** Default max total bytes across all completed runs: 500 MB */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

function handleListRuns() {
  const manifests = rescanRuns({ readOnly: true });
  manifests.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return {
    runs: manifests,
    totalRuns: manifests.length,
    activeRunId: getProfilerRunId() ?? null,
  };
}

function handleGetRun({ pathParams = {} }: RouteHandlerArgs) {
  const runId = validateRunId(pathParams.runId);

  const allManifests = rescanRuns({ readOnly: true });
  const manifest = allManifests.find((m) => m.runId === runId);
  if (!manifest) {
    throw new NotFoundError(`Profiler run '${runId}' not found`);
  }

  const runDir = getProfilerRunDir(runId);
  const summary = readProfileSummary(runDir);
  const activeRunId = getProfilerRunId();

  const maxBytes = getProfilerMaxBytes() ?? DEFAULT_MAX_BYTES;
  const totalBytesAllRuns = allManifests.reduce(
    (sum, m) => sum + m.totalBytes,
    0,
  );
  const remainingBytes = Math.max(0, maxBytes - totalBytesAllRuns);
  const overBudget = totalBytesAllRuns > maxBytes;

  return {
    ...manifest,
    summary: summary ?? null,
    isActive: runId === activeRunId,
    budget: {
      maxBytes,
      totalBytesAllRuns,
      remainingBytes,
      overBudget,
    },
  };
}

function handleExportRun({
  pathParams = {},
}: RouteHandlerArgs): Uint8Array {
  const runId = validateRunId(pathParams.runId);

  const runDir = getProfilerRunDir(runId);
  if (!existsSync(runDir)) {
    throw new NotFoundError(`Profiler run '${runId}' not found`);
  }

  const staging = mkdtempSync(join(tmpdir(), "vellum-profiler-export-"));

  try {
    copyDirContents(runDir, staging);

    const archiveBuf = createTarGz(staging);
    if (!archiveBuf) {
      log.error(
        { runId },
        "Profiler run archive exceeds size limit or tar failed",
      );
      throw new InternalError(
        `Profiler run '${runId}' exceeds the maximum archive size of ${MAX_ARCHIVE_BYTES} bytes`,
      );
    }

    return new Uint8Array(archiveBuf);
  } catch (err) {
    if (err instanceof RouteError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, runId }, "Failed to export profiler run");
    throw new InternalError(`Failed to export profiler run: ${message}`);
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

function handleDeleteRun({ pathParams = {} }: RouteHandlerArgs) {
  const runId = validateRunId(pathParams.runId);

  const activeRunId = getProfilerRunId();
  if (runId === activeRunId) {
    throw new ConflictError(
      `Cannot delete the currently active profiler run '${runId}'`,
    );
  }

  const runDir = getProfilerRunDir(runId);
  if (!existsSync(runDir)) {
    throw new NotFoundError(`Profiler run '${runId}' not found`);
  }

  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, runId }, "Failed to delete profiler run directory");
    throw new InternalError(`Failed to delete profiler run: ${message}`);
  }

  const sweepResult = runProfilerSweep();

  log.info(
    { runId, remainingRuns: sweepResult.remainingRuns },
    "Profiler run deleted",
  );

  return {
    deleted: true,
    runId,
    remainingRuns: sweepResult.remainingRuns,
    activeRunOverBudget: sweepResult.activeRunOverBudget,
  };
}

// ── File copying helper ────────────────────────────────────────────────

function copyDirContents(src: string, dest: string): void {
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    try {
      const stat = lstatSync(srcPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        copyDirContents(srcPath, destPath);
      } else if (stat.isFile()) {
        const content = readFileSync(srcPath);
        writeFileSync(destPath, content);
      }
    } catch {
      // Skip unreadable entries
    }
  }
}

// ── Route definitions ──────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "profiler_runs_get",
    endpoint: "profiler/runs",
    method: "GET",
    summary: "List profiler runs",
    description:
      "Enumerate all profiler run directories with manifest metadata, sorted newest-first.",
    tags: ["profiler"],
    requirePolicyEnforcement: true,
    handler: handleListRuns,
    responseBody: z.object({
      runs: z.array(
        z.object({
          runId: z.string(),
          status: z.enum(["active", "completed"]),
          createdAt: z.string(),
          updatedAt: z.string(),
          totalBytes: z.number(),
          completedAt: z.string().optional(),
        }),
      ),
      totalRuns: z.number(),
      activeRunId: z.string().nullable(),
    }),
  },
  {
    operationId: "profiler_runs_by_runId_get",
    endpoint: "profiler/runs/:runId",
    method: "GET",
    summary: "Get profiler run detail",
    description:
      "Return manifest metadata, Bun-generated markdown summary, and current retention state for a single profiler run.",
    tags: ["profiler"],
    requirePolicyEnforcement: true,
    handler: handleGetRun,
    responseBody: z.object({
      runId: z.string(),
      status: z.enum(["active", "completed"]),
      createdAt: z.string(),
      updatedAt: z.string(),
      totalBytes: z.number(),
      completedAt: z.string().optional(),
      summary: z.string().nullable(),
      isActive: z.boolean(),
      budget: z.object({
        maxBytes: z.number(),
        totalBytesAllRuns: z.number(),
        remainingBytes: z.number(),
        overBudget: z.boolean(),
      }),
    }),
  },
  {
    operationId: "profiler_runs_by_runId_export_post",
    endpoint: "profiler/runs/:runId/export",
    method: "POST",
    summary: "Export profiler run",
    description:
      "Package a single profiler run directory as a tar.gz bundle, subject to the same archive size limits used by runtime log exports.",
    tags: ["profiler"],
    requirePolicyEnforcement: true,
    handler: handleExportRun,
    responseHeaders: ({ pathParams = {} }) => ({
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="profiler-${pathParams.runId ?? "run"}.tar.gz"`,
    }),
  },
  {
    operationId: "profiler_runs_by_runId_delete",
    endpoint: "profiler/runs/:runId",
    method: "DELETE",
    summary: "Delete profiler run",
    description:
      "Delete a completed profiler run and recalculate disk-budget state. Rejects deletion of the currently active run.",
    tags: ["profiler"],
    requirePolicyEnforcement: true,
    handler: handleDeleteRun,
    responseBody: z.object({
      deleted: z.boolean(),
      runId: z.string(),
      remainingRuns: z.number(),
      activeRunOverBudget: z.boolean(),
    }),
  },
];
