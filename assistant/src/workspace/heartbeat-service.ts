import {
  checkDiskPressureBackgroundGate,
  diskPressureBackgroundSkipLogFields,
  shouldLogDiskPressureBackgroundSkip,
} from "../daemon/disk-pressure-background-gate.js";
import { getLogger } from "../util/logger.js";
import { getEnrichmentService } from "./commit-message-enrichment-service.js";
import {
  type CommitContext,
  type CommitMessageProvider,
  DefaultCommitMessageProvider,
} from "./commit-message-provider.js";
import {
  getAllWorkspaceGitServices,
  type WorkspaceGitService,
} from "./git-service.js";

const log = getLogger("heartbeat");

/** Threshold: commit if changes are older than this (ms). Default: 5 minutes. */
const DEFAULT_AGE_THRESHOLD_MS = 5 * 60 * 1000;

/** Threshold: commit if more than this many files have changed. Default: 20. */
const DEFAULT_FILE_THRESHOLD = 20;

/** How often the heartbeat runs (ms). Default: 5 minutes. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface WorkspaceHeartbeatServiceOptions {
  /** Maximum age of uncommitted changes before auto-commit (ms). */
  ageThresholdMs?: number;
  /** Maximum number of changed files before auto-commit. */
  fileThreshold?: number;
  /** Interval between heartbeat checks (ms). */
  intervalMs?: number;
  /** Override for getting workspace git services (for testing). */
  getServices?: () => ReadonlyMap<string, WorkspaceGitService>;
  /** Override for getting the current timestamp (for testing). */
  now?: () => number;
  /** Custom commit message provider. */
  commitMessageProvider?: CommitMessageProvider;
}

/**
 * Result of a single heartbeat check cycle.
 */
export interface HeartbeatCheckResult {
  /** Number of workspaces checked. */
  checked: number;
  /** Number of workspaces that had commits created. */
  committed: number;
  /** Number of workspaces skipped (clean or below thresholds). */
  skipped: number;
  /** Number of workspaces that failed during check. */
  failed: number;
}

/**
 * Tracks when changes were first detected in each workspace, so the heartbeat
 * can determine whether changes are "old enough" to warrant an auto-commit.
 */
const firstSeenDirty = new Map<string, number>();

/**
 * Heartbeat service that periodically checks all tracked workspaces for
 * uncommitted changes and auto-commits them when thresholds are met.
 *
 * This is a SAFETY NET -- turn-boundary commits (M2) handle the primary case.
 * The heartbeat catches:
 * - Long-running bash scripts that modify files without returning to the agent loop
 * - Background processes that write to the workspace
 * - Forgotten state from crashed or interrupted sessions
 */
export class WorkspaceHeartbeatService {
  private readonly ageThresholdMs: number;
  private readonly fileThreshold: number;
  private readonly intervalMs: number;
  private readonly getServices: () => ReadonlyMap<string, WorkspaceGitService>;
  private readonly now: () => number;
  private readonly commitMessageProvider: CommitMessageProvider;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Tracks the currently in-flight check to prevent overlapping runs and allow clean shutdown. */
  private activeCheck: Promise<HeartbeatCheckResult> | null = null;

  constructor(options?: WorkspaceHeartbeatServiceOptions) {
    this.ageThresholdMs = options?.ageThresholdMs ?? DEFAULT_AGE_THRESHOLD_MS;
    this.fileThreshold = options?.fileThreshold ?? DEFAULT_FILE_THRESHOLD;
    this.intervalMs = options?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.getServices = options?.getServices ?? getAllWorkspaceGitServices;
    this.now = options?.now ?? Date.now;
    this.commitMessageProvider =
      options?.commitMessageProvider ?? new DefaultCommitMessageProvider();
  }

  /**
   * Start the periodic heartbeat timer.
   * Idempotent -- calling start() when already running is a no-op.
   */
  start(): void {
    if (this.timer) return;
    log.info(
      {
        intervalMs: this.intervalMs,
        ageThresholdMs: this.ageThresholdMs,
        fileThreshold: this.fileThreshold,
      },
      "Heartbeat service started",
    );
    this.timer = setInterval(() => {
      this.check().catch((err) => {
        log.error({ err }, "Heartbeat check failed");
      });
    }, this.intervalMs);
  }

  /**
   * Stop the periodic heartbeat timer and wait for any in-flight check to complete.
   * This prevents races between the heartbeat check and shutdown commits.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeCheck) {
      await this.activeCheck;
    }
    log.info("Heartbeat service stopped");
  }

  /**
   * Run a single heartbeat check across all tracked workspaces.
   * For each workspace with uncommitted changes that exceed the age or file
   * threshold, an auto-commit is created.
   *
   * If a previous check is still in-flight, this returns immediately with
   * zeroed results to prevent overlapping commits on the same workspaces.
   */
  async check(): Promise<HeartbeatCheckResult> {
    // Guard: skip if a previous check is still running
    if (this.activeCheck) {
      return { checked: 0, committed: 0, skipped: 0, failed: 0 };
    }

    const diskPressureGate = checkDiskPressureBackgroundGate("background-work");
    if (diskPressureGate.action === "skip") {
      if (shouldLogDiskPressureBackgroundSkip("workspace-heartbeat")) {
        log.warn(
          {
            source: "workspace-heartbeat",
            ...diskPressureBackgroundSkipLogFields(diskPressureGate),
          },
          "Workspace heartbeat skipped during disk pressure cleanup mode",
        );
      }
      return { checked: 0, committed: 0, skipped: 0, failed: 0 };
    }

    const doCheck = async (): Promise<HeartbeatCheckResult> => {
      const result: HeartbeatCheckResult = {
        checked: 0,
        committed: 0,
        skipped: 0,
        failed: 0,
      };

      const services = this.getServices();

      for (const [workspaceDir, service] of services) {
        // Only check workspaces that have been initialized (have a .git dir).
        // Skip workspaces that haven't been used yet to avoid spurious init.
        if (!service.isInitialized()) {
          continue;
        }

        result.checked++;

        try {
          const committed = await this.checkWorkspace(workspaceDir, service);
          if (committed) {
            result.committed++;
          } else {
            result.skipped++;
          }
        } catch (err) {
          log.warn(
            { err, workspaceDir },
            "Heartbeat check failed for workspace",
          );
          result.failed++;
        }
      }

      if (result.committed > 0) {
        log.info(result, "Heartbeat check completed with commits");
      }

      return result;
    };

    this.activeCheck = doCheck();
    try {
      return await this.activeCheck;
    } finally {
      this.activeCheck = null;
    }
  }

  /**
   * Commit any pending changes in all tracked workspaces as a shutdown safety net.
   * Called during graceful daemon shutdown to ensure no workspace state is lost.
   */
  async commitAllPending(): Promise<HeartbeatCheckResult> {
    const result: HeartbeatCheckResult = {
      checked: 0,
      committed: 0,
      skipped: 0,
      failed: 0,
    };

    const services = this.getServices();

    for (const [workspaceDir, service] of services) {
      if (!service.isInitialized()) {
        continue;
      }

      result.checked++;

      try {
        const now = this.now();
        const { committed } = await service.commitIfDirty(
          (st) => {
            const uniqueFiles = [
              ...new Set([...st.staged, ...st.modified, ...st.untracked]),
            ];
            log.info(
              { workspaceDir, totalChanges: uniqueFiles.length },
              "Committing pending changes on shutdown",
            );

            const ctx: CommitContext = {
              workspaceDir,
              trigger: "shutdown",
              changedFiles: uniqueFiles,
              timestampMs: now,
            };

            return this.commitMessageProvider.buildImmediateMessage(ctx);
          },
          { bypassBreaker: true },
        );

        if (committed) {
          firstSeenDirty.delete(workspaceDir);
          result.committed++;
          // Skip enrichment for shutdown commits — the enrichment queue is
          // about to be shut down anyway, and the fire-and-forget writeNote()
          // can race with subsequent commitAllPending() calls (the async
          // git-notes operation acquires the mutex and may leave behind an
          // index.lock on some git versions, causing the next commit to fail).
        } else {
          result.skipped++;
        }
      } catch (err) {
        log.warn({ err, workspaceDir }, "Shutdown commit failed for workspace");
        result.failed++;
      }
    }

    if (result.committed > 0) {
      log.info(result, "Shutdown commits completed");
    }

    return result;
  }

  /**
   * Check a single workspace and commit if thresholds are exceeded.
   *
   * @returns true if a commit was created
   */
  private async checkWorkspace(
    workspaceDir: string,
    service: WorkspaceGitService,
  ): Promise<boolean> {
    const now = this.now();
    let heartbeatFiles: string[] = [];
    let heartbeatReason: string | undefined;

    // Atomic status check + conditional commit within a single mutex lock.
    const { committed, status } = await service.commitIfDirty((st) => {
      const uniqueFiles = [
        ...new Set([...st.staged, ...st.modified, ...st.untracked]),
      ];
      const totalChanges = uniqueFiles.length;

      // Track when we first saw this workspace as dirty
      if (!firstSeenDirty.has(workspaceDir)) {
        firstSeenDirty.set(workspaceDir, now);
      }

      const dirtyAge = now - firstSeenDirty.get(workspaceDir)!;

      // Check thresholds: commit if changes are old enough OR if too many files changed
      const ageExceeded = dirtyAge >= this.ageThresholdMs;
      const fileCountExceeded = totalChanges >= this.fileThreshold;

      if (!ageExceeded && !fileCountExceeded) {
        log.debug(
          { workspaceDir, totalChanges, dirtyAgeMs: dirtyAge },
          "Changes below threshold, skipping heartbeat commit",
        );
        return null; // Don't commit yet
      }

      const reason = ageExceeded
        ? `changes older than ${Math.round(dirtyAge / 1000)}s`
        : `${totalChanges} files changed (threshold: ${this.fileThreshold})`;

      heartbeatFiles = uniqueFiles;
      heartbeatReason = reason;

      log.info(
        { workspaceDir, totalChanges, dirtyAgeMs: dirtyAge, reason },
        "Heartbeat auto-committing workspace changes",
      );

      const ctx: CommitContext = {
        workspaceDir,
        trigger: "heartbeat",
        changedFiles: uniqueFiles,
        timestampMs: now,
        reason,
      };

      return this.commitMessageProvider.buildImmediateMessage(ctx);
    });

    if (committed) {
      firstSeenDirty.delete(workspaceDir);

      // Fire-and-forget enrichment
      try {
        const commitHash = await service.getHeadHash();
        const hbCtx: CommitContext = {
          workspaceDir,
          trigger: "heartbeat",
          changedFiles: heartbeatFiles,
          timestampMs: now,
          reason: heartbeatReason,
        };
        getEnrichmentService().enqueue({
          workspaceDir,
          commitHash,
          context: hbCtx,
          gitService: service,
        });
      } catch (enrichErr) {
        log.debug(
          { enrichErr },
          "Failed to enqueue heartbeat enrichment (non-fatal)",
        );
      }

      return true;
    }

    if (status.clean) {
      firstSeenDirty.delete(workspaceDir);
    }

    return false;
  }
}

/**
 * @internal Test-only: clear the dirty tracking state
 */
export function _resetHeartbeatState(): void {
  firstSeenDirty.clear();
}
