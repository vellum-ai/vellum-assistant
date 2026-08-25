import { randomUUID } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";

import type { AssistantEntry } from "./assistant-config.js";
import { dockerResourceNames } from "./docker.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import { exec } from "./step-runner.js";

/** Workspace-relative directory the daemon will open for staged restores. */
export const RESTORE_STAGING_DIRNAME = ".restore-staging";

export type RestoreStagingTarget =
  | { kind: "local"; instanceDir: string }
  | { kind: "docker"; assistantId: string };

export interface StagedBundle {
  /** Path the daemon should receive in `{ path }`. */
  relativePath: string;
  cleanup: () => Promise<void>;
}

const IMPORT_POLL_INTERVAL_MS = 2_000;
const IMPORT_POLL_TIMEOUT_MS = 60 * 60 * 1000;

export function stagingTargetFromEntry(
  entry: AssistantEntry,
): RestoreStagingTarget | null {
  const cloud =
    entry.cloud || (entry.project ? "gcp" : entry.sshUser ? "custom" : "local");
  if (cloud === "docker") {
    return { kind: "docker", assistantId: entry.assistantId };
  }
  if (cloud === "local" && entry.resources?.instanceDir) {
    return { kind: "local", instanceDir: entry.resources.instanceDir };
  }
  return null;
}

function localWorkspaceDir(instanceDir: string): string {
  return join(instanceDir, ".vellum", "workspace");
}

export function formatBundleSizeMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/**
 * Copy a host `.vbundle` into the assistant workspace staging directory
 * so the daemon can stream it without a large HTTP body.
 */
export async function stageBundleForRestore(
  target: RestoreStagingTarget,
  hostBundlePath: string,
): Promise<StagedBundle> {
  const filename = `${randomUUID()}.vbundle`;
  const relativePath = `${RESTORE_STAGING_DIRNAME}/${filename}`;

  if (target.kind === "local") {
    const stagingDir = join(
      localWorkspaceDir(target.instanceDir),
      RESTORE_STAGING_DIRNAME,
    );
    mkdirSync(stagingDir, { recursive: true });
    const dest = join(stagingDir, filename);
    copyFileSync(hostBundlePath, dest);
    return {
      relativePath,
      cleanup: async () => {
        try {
          unlinkSync(dest);
        } catch {
          // Best-effort: a successful import may have swapped the workspace.
        }
      },
    };
  }

  const container = dockerResourceNames(target.assistantId).assistantContainer;
  const dest = `/workspace/${relativePath}`;
  await exec("docker", [
    "exec",
    container,
    "mkdir",
    "-p",
    `/workspace/${RESTORE_STAGING_DIRNAME}`,
  ]);
  await exec("docker", ["cp", hostBundlePath, `${container}:${dest}`]);
  return {
    relativePath,
    cleanup: async () => {
      try {
        await exec("docker", ["exec", container, "rm", "-f", dest]);
      } catch {
        // Best-effort: a successful import may have swapped the workspace.
      }
    },
  };
}

export async function preflightStagedBundle(
  runtimeUrl: string,
  accessToken: string,
  relativePath: string,
): Promise<Response> {
  return loopbackSafeFetch(`${runtimeUrl}/v1/migrations/import-preflight`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: relativePath }),
    signal: AbortSignal.timeout(120_000),
  });
}

/**
 * Import a staged bundle. The gateway JSON import path returns 202 and
 * requires status polling; a direct daemon response of 200 is accepted too.
 */
export async function importStagedBundle(
  runtimeUrl: string,
  accessToken: string,
  relativePath: string,
): Promise<Response> {
  const postImport = () =>
    loopbackSafeFetch(`${runtimeUrl}/v1/migrations/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: relativePath }),
      signal: AbortSignal.timeout(120_000),
    });

  const response = await postImport();

  if (response.status === 202) {
    const accepted = (await response.json()) as { job_id?: string };
    if (!accepted.job_id) {
      return new Response(
        JSON.stringify({ error: "Import did not return a job_id" }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
    return pollImportJob(runtimeUrl, accessToken, accepted.job_id);
  }

  return response;
}

async function pollImportJob(
  runtimeUrl: string,
  accessToken: string,
  jobId: string,
): Promise<Response> {
  const deadline = Date.now() + IMPORT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const statusResponse = await loopbackSafeFetch(
      `${runtimeUrl}/v1/migrations/import/${jobId}/status`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (statusResponse.status === 404) {
      return new Response(
        JSON.stringify({ error: `Unknown import job: ${jobId}` }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    if (!statusResponse.ok) {
      return statusResponse;
    }

    const job = (await statusResponse.json()) as {
      status?: string;
      error?: string;
      result?: unknown;
    };
    if (job.status === "complete") {
      return new Response(JSON.stringify(job.result ?? { success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (job.status === "failed") {
      return new Response(
        JSON.stringify({
          success: false,
          message: job.error ?? "Import failed",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_INTERVAL_MS));
  }

  return new Response(
    JSON.stringify({ error: "Import timed out after 60 minutes" }),
    { status: 504, headers: { "Content-Type": "application/json" } },
  );
}

export function bundleFileSizeBytes(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  return statSync(path).size;
}
