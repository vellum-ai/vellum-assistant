/**
 * Sidebar footer banner prompting the user to upgrade when a newer assistant
 * release is available. Shown inside `AssistantSideMenu` via the `footerBanner`
 * prop, positioned above the preferences menu.
 *
 * Fetches the release list and compares against the assistant's current version
 * using the shared semver utilities. Dismissal is persisted per-version in
 * localStorage so the banner reappears only when a newer release ships.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library";
import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsRetrieveOptions,
  assistantsRetrieveQueryKey,
  releasesListOptions,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { assistantsUpgradeDetailCreate } from "@/generated/api/sdk.gen.js";
import { compareParsed, parseSemver } from "@/lib/semver/semver.js";
import { useAssistantAvatar } from "@/domains/avatar/use-assistant-avatar.js";
import { AvatarRenderer } from "@/components/avatar-renderer.js";

const DISMISS_STORAGE_KEY = "updateBannerDismissed";
const POLL_INTERVAL_MS = 3000;

interface DismissRecord {
  version: string;
  dismissedAt: number;
}

function readDismissRecord(): DismissRecord | null {
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DismissRecord;
  } catch {
    return null;
  }
}

function writeDismissRecord(version: string): void {
  try {
    const record: DismissRecord = { version, dismissedAt: Date.now() };
    window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable
  }
}

interface UpdateAvailableSidebarEntryProps {
  assistantId: string;
}

export function UpdateAvailableSidebarEntry({
  assistantId,
}: UpdateAvailableSidebarEntryProps) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const targetVersionRef = useRef<string | null>(null);

  const { data: assistant } = useQuery(
    assistantsRetrieveOptions({ path: { id: assistantId } }),
  );

  const pollRefetchInterval = (version: string | null | undefined) => {
    if (
      version &&
      targetVersionRef.current &&
      version === targetVersionRef.current
    ) {
      queueMicrotask(() => {
        setIsPollingUpgrade(false);
        targetVersionRef.current = null;
        toast.success("Update complete — assistant is healthy.");
      });
      return false as const;
    }
    return POLL_INTERVAL_MS;
  };

  useQuery({
    ...assistantsRetrieveOptions({ path: { id: assistantId } }),
    refetchInterval: isPollingUpgrade
      ? (query) =>
          pollRefetchInterval(query.state.data?.current_release_version)
      : false,
  });

  const currentVersion = assistant?.current_release_version ?? null;

  const { data: releases } = useQuery(
    releasesListOptions({ query: { stable: true } }),
  );

  const latestRelease =
    releases?.find((r) => r.is_stable !== false) ?? releases?.[0];
  const latestVersion = latestRelease?.version ?? null;

  const upgradeAvailable = useMemo(() => {
    if (!latestVersion || !currentVersion) return false;
    const latest = parseSemver(latestVersion);
    const current = parseSemver(currentVersion);
    if (!latest || !current) return latestVersion !== currentVersion;
    return compareParsed(latest, current) > 0;
  }, [latestVersion, currentVersion]);

  const isDismissedForVersion = useMemo(() => {
    if (!latestVersion) return false;
    const record = readDismissRecord();
    return record?.version === latestVersion;
  }, [latestVersion]);

  const avatar = useAssistantAvatar(assistantId);

  const upgradeMutation = useMutation({
    mutationFn: async () => {
      const { data } = await assistantsUpgradeDetailCreate({
        path: { id: assistantId },
        body: {},
        throwOnError: true,
      });
      return data;
    },
  });

  const handleUpgradeNow = useCallback(async () => {
    try {
      const result = await upgradeMutation.mutateAsync();
      const isNoOp = result.detail?.includes("Already on the latest");
      if (isNoOp) {
        toast.success(result.detail);
        return;
      }
      targetVersionRef.current =
        result.version ?? latestVersion ?? null;
      toast.success(
        result.detail ??
          `Update to ${result.version ?? latestVersion ?? "latest"} initiated.`,
      );
      setIsPollingUpgrade(true);
      queryClient.invalidateQueries({
        queryKey: assistantsRetrieveQueryKey({
          path: { id: assistantId },
        }),
      });
    } catch {
      toast.error("Failed to trigger update. Please try again.");
    }
  }, [upgradeMutation, latestVersion, assistantId, queryClient]);

  const handleDismiss = useCallback(() => {
    if (latestVersion) {
      writeDismissRecord(latestVersion);
    }
    setDismissed(true);
  }, [latestVersion]);

  if (!upgradeAvailable || dismissed || isDismissedForVersion) {
    return null;
  }

  const isUpgrading = upgradeMutation.isPending || isPollingUpgrade;

  return (
    <div
      data-slot="update-available-sidebar-entry"
      className="group relative overflow-hidden rounded-lg border"
      style={{
        background: "var(--surface-overlay)",
        borderColor: "var(--border-base)",
        animation: "fadeInUp 0.25s ease-out both",
      }}
    >
      <button
        type="button"
        className="absolute right-1.5 top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-md transition-opacity hover:opacity-70"
        style={{ color: "var(--content-tertiary)" }}
        onClick={handleDismiss}
        aria-label="Dismiss update banner"
      >
        <X size={12} aria-hidden />
      </button>

      <div className="flex gap-3 px-3 py-3">
        {avatar.components ? (
          <AvatarRenderer
            components={avatar.components}
            bodyShapeId={avatar.traits?.bodyShape ?? "default"}
            eyeStyleId={avatar.traits?.eyeStyle ?? "default"}
            colorId={avatar.traits?.color ?? "default"}
            size={32}
            className="shrink-0"
          />
        ) : avatar.customImageUrl ? (
          <img
            src={avatar.customImageUrl}
            alt="Assistant avatar"
            className="size-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div
            className="size-8 shrink-0 rounded-full"
            style={{ background: "var(--surface-active)" }}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p
            className="text-body-small-default leading-tight pr-4"
            style={{ color: "var(--content-default)" }}
          >
            New version — {latestVersion}
          </p>

          <div className="flex gap-2">
            <Button
              variant="primary"
              size="compact"
              onClick={() => void handleUpgradeNow()}
              disabled={isUpgrading}
              leftIcon={
                isUpgrading ? (
                  <Loader2 className="animate-spin" />
                ) : undefined
              }
            >
              {isUpgrading ? "Updating…" : "Upgrade now"}
            </Button>
            <Button
              variant="outlined"
              size="compact"
              onClick={handleDismiss}
              disabled={isUpgrading}
            >
              Upgrade later
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
