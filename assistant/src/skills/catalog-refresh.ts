/**
 * Staleness refresh for catalog-installed skills.
 *
 * First-party catalog skills are installed as a copy under
 * `$VELLUM_WORKSPACE_DIR/skills/<id>` and load with user-skill precedence, so
 * a skill fix published to the catalog never reaches an assistant that
 * already has the skill installed unless the copy is refreshed. This module
 * refreshes a copy in place when three conditions hold:
 *
 * 1. The install is catalog-managed (`origin: "vellum"` in install-meta).
 * 2. The copy is pristine — its current content hash matches the hash
 *    recorded at install time. A user-modified copy is never overwritten.
 * 3. The catalog entry is newer than the installed content's provenance
 *    stamp (`catalogUpdatedAt`, falling back to `installedAt` for installs
 *    that predate the stamp).
 *
 * Refresh goes through `installSkillLocally` with overwrite, which stages,
 * validates, and atomically swaps with rollback on failure.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import { getCatalog } from "./catalog-cache.js";
import {
  ConcurrentSkillModificationError,
  installSkillLocally,
} from "./catalog-install.js";
import {
  computeSkillHash,
  readInstallMeta,
  type SkillInstallMeta,
} from "./install-meta.js";

const log = getLogger("catalog-refresh");

export type SkillRefreshOutcome =
  | "refreshed"
  | "fresh"
  | "skipped_not_installed"
  | "skipped_not_catalog_managed"
  | "skipped_no_recorded_hash"
  | "skipped_locally_modified"
  | "skipped_no_catalog_entry"
  | "failed";

/**
 * In-flight refreshes keyed by skillId. Concurrent loads of the same skill
 * (parallel conversations) must not race two staged installs on the same
 * target directory — the second caller awaits the first's outcome.
 */
const inflightRefreshes = new Map<string, Promise<SkillRefreshOutcome>>();

/**
 * Refresh a workspace-installed catalog skill in place when the catalog has
 * a newer version and the local copy is pristine. Best-effort: never throws;
 * failures resolve as `"failed"`.
 */
export function refreshInstalledSkillIfStale(
  skillId: string,
): Promise<SkillRefreshOutcome> {
  const existing = inflightRefreshes.get(skillId);
  if (existing) {
    return existing;
  }

  const refresh = doRefresh(skillId).finally(() => {
    inflightRefreshes.delete(skillId);
  });
  inflightRefreshes.set(skillId, refresh);
  return refresh;
}

async function doRefresh(skillId: string): Promise<SkillRefreshOutcome> {
  try {
    const skillDir = join(getWorkspaceSkillsDir(), skillId);
    if (!existsSync(join(skillDir, "SKILL.md"))) {
      return "skipped_not_installed";
    }

    const meta = readInstallMeta(skillDir);
    if (!meta || meta.origin !== "vellum") {
      return "skipped_not_catalog_managed";
    }
    if (!meta.contentHash) {
      // Legacy install with no recorded hash — pristineness is unknowable,
      // so never overwrite.
      return "skipped_no_recorded_hash";
    }
    if (computeSkillHash(skillDir) !== meta.contentHash) {
      return "skipped_locally_modified";
    }

    const catalog = await getCatalog();
    const entry = catalog.find((s) => s.id === skillId);
    if (!entry?.updatedAt) {
      return "skipped_no_catalog_entry";
    }

    if (!isCatalogEntryNewer(entry.updatedAt, meta)) {
      return "fresh";
    }

    // Pin the hash checked above: the overwrite proceeds only if the on-disk
    // copy is still identical at swap time. A user edit landing during the
    // catalog fetch / staged download (the swap can complete in the
    // background after the load-path timeout) aborts the swap and preserves
    // their copy instead of silently discarding it.
    await installSkillLocally(
      skillId,
      entry,
      true,
      undefined,
      meta.contentHash,
    );
    log.info(
      {
        skillId,
        catalogUpdatedAt: entry.updatedAt,
        previousCatalogUpdatedAt: meta.catalogUpdatedAt,
        installedAt: meta.installedAt,
      },
      "Refreshed stale catalog skill install",
    );
    return "refreshed";
  } catch (err) {
    if (err instanceof ConcurrentSkillModificationError) {
      // The user edited the skill mid-refresh; their copy was preserved.
      log.info(
        { skillId },
        "Skill modified during refresh; kept the local copy",
      );
      return "skipped_locally_modified";
    }
    log.warn({ err, skillId }, "Failed to refresh catalog skill install");
    return "failed";
  }
}

/**
 * Whether the catalog entry's `updatedAt` is strictly newer than the
 * installed copy's provenance baseline.
 *
 * The baseline is `catalogUpdatedAt` (the catalog stamp of the content that
 * was installed) when recorded; older installs fall back to `installedAt`,
 * which is correct for the common case (a publish after the install) but
 * cannot detect an install made from an already-stale source. An
 * unparseable baseline refreshes once to establish proper provenance.
 */
function isCatalogEntryNewer(
  entryUpdatedAt: string,
  meta: SkillInstallMeta,
): boolean {
  const entryTime = Date.parse(entryUpdatedAt);
  if (!Number.isFinite(entryTime)) {
    return false;
  }

  const baselineStamp = meta.catalogUpdatedAt ?? meta.installedAt;
  const baselineTime = Date.parse(baselineStamp);
  if (!Number.isFinite(baselineTime)) {
    return true;
  }

  return entryTime > baselineTime;
}
