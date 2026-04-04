/**
 * HTTP route handlers for managed profiler run management.
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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import { createTarGz, MAX_ARCHIVE_BYTES } from "./archive-utils.js";

const log = getLogger("profiler-routes");

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Read the Bun-generated profiler markdown summary from a run directory.
 * Bun writes CPU profile summaries as `.md` files; we look for the first
 * markdown file in the run directory.
 */
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

// ── Route handlers ─────────────────────────────────────────────────────

/**
 * GET /v1/profiler/runs — list all profiler runs with manifest metadata.
 */
function handleListRuns(): Response {
  const manifests = rescanRuns({ readOnly: true });

  // Sort newest-first for the listing
  manifests.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return Response.json({
    runs: manifests,
    totalRuns: manifests.length,
    activeRunId: getProfilerRunId() ?? null,
  });
}

/** Default max total bytes across all completed runs: 500 MB */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/**
 * GET /v1/profiler/runs/:runId — detail view with manifest + markdown summary
 * plus current budget/retention state.
 */
function handleGetRun(runId: string): Response {
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    return httpError("BAD_REQUEST", "Invalid run ID", 400);
  }

  // Rescan all runs first to get freshly computed totalBytes for every run,
  // then find the target run in the results. This avoids using a stale
  // manifest from the last write-through rescan.
  const allManifests = rescanRuns({ readOnly: true });
  const manifest = allManifests.find((m) => m.runId === runId);
  if (!manifest) {
    return httpError("NOT_FOUND", `Profiler run '${runId}' not found`, 404);
  }

  const runDir = getProfilerRunDir(runId);
  const summary = readProfileSummary(runDir);
  const activeRunId = getProfilerRunId();

  // Compute budget state from all runs
  const maxBytes = getProfilerMaxBytes() ?? DEFAULT_MAX_BYTES;
  const totalBytesAllRuns = allManifests.reduce(
    (sum, m) => sum + m.totalBytes,
    0,
  );
  const remainingBytes = Math.max(0, maxBytes - totalBytesAllRuns);
  const overBudget = totalBytesAllRuns > maxBytes;

  return Response.json({
    ...manifest,
    summary: summary ?? null,
    isActive: runId === activeRunId,
    budget: {
      maxBytes,
      totalBytesAllRuns,
      remainingBytes,
      overBudget,
    },
  });
}

/**
 * POST /v1/profiler/runs/:runId/export — package a single run as tar.gz.
 */
function handleExportRun(runId: string): Response {
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    return httpError("BAD_REQUEST", "Invalid run ID", 400);
  }

  const runDir = getProfilerRunDir(runId);
  if (!existsSync(runDir)) {
    return httpError("NOT_FOUND", `Profiler run '${runId}' not found`, 404);
  }

  // Stage the run directory contents into a temp directory to avoid
  // including parent path structure in the archive.
  const staging = mkdtempSync(join(tmpdir(), "vellum-profiler-export-"));

  try {
    // Copy run directory contents into the staging area
    copyDirContents(runDir, staging);

    const archiveBytes = createTarGz(staging);
    if (!archiveBytes) {
      log.error(
        { runId },
        "Profiler run archive exceeds size limit or tar failed",
      );
      return httpError(
        "INTERNAL_ERROR",
        `Profiler run '${runId}' exceeds the maximum archive size of ${MAX_ARCHIVE_BYTES} bytes`,
        500,
      );
    }

    return new Response(archiveBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="profiler-${runId}.tar.gz"`,
        "Content-Length": String(archiveBytes.byteLength),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, runId }, "Failed to export profiler run");
    return httpError(
      "INTERNAL_ERROR",
      `Failed to export profiler run: ${message}`,
      500,
    );
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * DELETE /v1/profiler/runs/:runId — delete a completed run and recalculate
 * disk-budget state.
 */
function handleDeleteRun(runId: string): Response {
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) {
    return httpError("BAD_REQUEST", "Invalid run ID", 400);
  }

  const activeRunId = getProfilerRunId();
  if (runId === activeRunId) {
    return httpError(
      "CONFLICT",
      `Cannot delete the currently active profiler run '${runId}'`,
      409,
    );
  }

  const runDir = getProfilerRunDir(runId);
  if (!existsSync(runDir)) {
    return httpError("NOT_FOUND", `Profiler run '${runId}' not found`, 404);
  }

  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, runId }, "Failed to delete profiler run directory");
    return httpError(
      "INTERNAL_ERROR",
      `Failed to delete profiler run: ${message}`,
      500,
    );
  }

  // Re-run the sweep to recompute disk-budget state after deletion
  const sweepResult = runProfilerSweep();

  log.info(
    { runId, remainingRuns: sweepResult.remainingRuns },
    "Profiler run deleted",
  );

  return Response.json({
    deleted: true,
    runId,
    remainingRuns: sweepResult.remainingRuns,
    activeRunOverBudget: sweepResult.activeRunOverBudget,
  });
}

// ── File copying helper ────────────────────────────────────────────────

/**
 * Recursively copy all files and directories from `src` into `dest`.
 */
function copyDirContents(src: string, dest: string): void {
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    try {
      const stat = lstatSync(srcPath);
      // Skip symlinks for defense-in-depth — a symlink inside a run
      // directory could point outside the run and exfiltrate files.
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

export function profilerRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "profiler/runs",
      method: "GET",
      policyKey: "profiler/runs",
      summary: "List profiler runs",
      description:
        "Enumerate all profiler run directories with manifest metadata, sorted newest-first.",
      tags: ["profiler"],
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
      handler: () => handleListRuns(),
    },
    {
      endpoint: "profiler/runs/:runId",
      method: "GET",
      policyKey: "profiler/runs",
      summary: "Get profiler run detail",
      description:
        "Return manifest metadata, Bun-generated markdown summary, and current retention state for a single profiler run.",
      tags: ["profiler"],
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
      handler: ({ params }) => handleGetRun(params.runId),
    },
    {
      endpoint: "profiler/runs/:runId/export",
      method: "POST",
      policyKey: "profiler/runs/export",
      summary: "Export profiler run",
      description:
        "Package a single profiler run directory as a tar.gz bundle, subject to the same archive size limits used by runtime log exports.",
      tags: ["profiler"],
      handler: ({ params }) => handleExportRun(params.runId),
    },
    {
      endpoint: "profiler/runs/:runId",
      method: "DELETE",
      policyKey: "profiler/runs",
      summary: "Delete profiler run",
      description:
        "Delete a completed profiler run and recalculate disk-budget state. Rejects deletion of the currently active run.",
      tags: ["profiler"],
      responseBody: z.object({
        deleted: z.boolean(),
        runId: z.string(),
        remainingRuns: z.number(),
        activeRunOverBudget: z.boolean(),
      }),
      handler: ({ params }) => handleDeleteRun(params.runId),
    },
  ];
}
