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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
const POLL_TIMEOUT_MS = 60_000;

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
  onVisibilityChange?: (visible: boolean) => void;
}

export function useIsUpdateBannerVisible(assistantId: string | null): boolean {
  const { data: assistant } = useQuery({
    ...assistantsRetrieveOptions({ path: { id: assistantId ?? "" } }),
    enabled: !!assistantId,
  });

  const { data: releases } = useQuery(
    releasesListOptions({ query: { stable: true } }),
  );

  const currentVersion = assistant?.current_release_version ?? null;
  const latestRelease =
    releases?.find((r) => r.is_stable !== false) ?? releases?.[0];
  const latestVersion = latestRelease?.version ?? null;

  return useMemo(() => {
    if (!latestVersion || !currentVersion) return false;
    const latest = parseSemver(latestVersion);
    const current = parseSemver(currentVersion);
    if (!latest || !current) return latestVersion !== currentVersion;
    const upgradeAvailable = compareParsed(latest, current) > 0;
    if (!upgradeAvailable) return false;
    const record = readDismissRecord();
    return record?.version !== latestVersion;
  }, [latestVersion, currentVersion]);
}

export function UpdateAvailableSidebarEntry({
  assistantId,
  onVisibilityChange,
}: UpdateAvailableSidebarEntryProps) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [isPollingUpgrade, setIsPollingUpgrade] = useState(false);
  const targetVersionRef = useRef<string | null>(null);
  const pollStartedAtRef = useRef<number>(0);

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
        pollStartedAtRef.current = 0;
        toast.success("Update complete — assistant is healthy.");
      });
      return false as const;
    }
    if (Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
      queueMicrotask(() => {
        setIsPollingUpgrade(false);
        targetVersionRef.current = null;
        pollStartedAtRef.current = 0;
        toast.error("Update is taking longer than expected. Please check Settings.");
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

  useEffect(() => {
    setDismissed(false);
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
      pollStartedAtRef.current = Date.now();
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
    onVisibilityChange?.(false);
  }, [latestVersion, onVisibilityChange]);

  const isVisible = upgradeAvailable && !dismissed && !isDismissedForVersion;

  useEffect(() => {
    onVisibilityChange?.(isVisible);
  }, [isVisible, onVisibilityChange]);

  if (!isVisible) {
    return null;
  }

  const isUpgrading = upgradeMutation.isPending || isPollingUpgrade;

  return (
    <div
      data-slot="update-available-sidebar-entry"
      className="flex flex-col gap-2 overflow-hidden rounded-lg border px-3 py-3"
      style={{
        background: "var(--surface-overlay)",
        borderColor: "var(--border-base)",
        animation: "fadeInUp 0.25s ease-out both",
      }}
    >
      <div className="flex items-center gap-3">
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

        <p
          className="min-w-0 flex-1 truncate text-body-small-default leading-tight"
          style={{ color: "var(--content-default)" }}
          title={`New version — ${latestVersion}`}
        >
          New version — {latestVersion}
        </p>

        <button
          type="button"
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md transition-opacity hover:opacity-70"
          style={{ color: "var(--content-tertiary)" }}
          onClick={handleDismiss}
          aria-label="Dismiss update banner"
        >
          <X size={12} aria-hidden />
        </button>
      </div>

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
  );
}
