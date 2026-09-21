import { useEffect, useRef, useState } from "react";

import type { CompanionIntroBeat } from "@vellumai/ipc-contract";

import { captureError } from "@/lib/sentry/capture-error";
import {
  getSystemPermissionsState,
  openSystemPermissionSettings,
  requestSystemPermission,
  subscribeToSystemPermissions,
  type SystemPermissionsState,
  type SystemPermissionStateItem,
} from "@/runtime/system-permissions";

export type CompanionIntroPermissionKind =
  "microphone" | "inputMonitoring" | "screen";
export type CompanionIntroPermissionState =
  | { phase: "checking" | "requesting" | "error" }
  | { phase: "known"; item: SystemPermissionStateItem };

export interface CompanionIntroPermission {
  kind: CompanionIntroPermissionKind;
  state: CompanionIntroPermissionState;
  enable: () => void;
}

export function companionIntroOpensSettings(
  kind: CompanionIntroPermissionKind,
  item: SystemPermissionStateItem | null,
): boolean {
  return (
    kind === "inputMonitoring" ||
    item?.canRequest === false ||
    (kind !== "screen" && item?.status === "denied")
  );
}

function permissionFor(
  beat: CompanionIntroBeat | null,
): CompanionIntroPermissionKind | null {
  switch (beat) {
    case "talk":
    case "try":
      return "microphone";
    case "key":
      return "inputMonitoring";
    case "share":
      return "screen";
    default:
      return null;
  }
}

export function companionIntroNeedsPermission(
  permission: CompanionIntroPermission | null,
): boolean {
  return (
    permission !== null &&
    (permission.state.phase !== "known" ||
      permission.state.item.status !== "granted")
  );
}

export function useCompanionIntroPermission(
  beat: CompanionIntroBeat | null,
): CompanionIntroPermission | null {
  const kind = permissionFor(beat);
  const tourActive = beat !== null;
  const [permissions, setPermissions] = useState<
    SystemPermissionsState | null | undefined
  >(undefined);
  const [action, setAction] = useState<{
    kind: CompanionIntroPermissionKind;
    phase: "requesting" | "error";
  } | null>(null);
  const enableRef = useRef<() => void>(() => {});

  useEffect(() => {
    setAction(null);
    if (!tourActive) {
      return;
    }
    let active = true;
    let pending = false;
    let revision = 0;
    let pollGeneration = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const record = (state: SystemPermissionsState | null) => {
      if (!active) {
        return;
      }
      setPermissions((previous) => {
        if (JSON.stringify(previous) === JSON.stringify(state)) {
          return previous;
        }
        return state;
      });
      setAction(null);
    };
    const failed = (error: unknown) => {
      if (active) {
        if (kind !== null) {
          setAction({ kind, phase: "error" });
        }
        captureError(error, {
          context: "companionIntro.permission",
          tags: { kind: kind ?? "tour" },
        });
      }
    };
    const read = async () => {
      const reading = revision;
      try {
        const state = await getSystemPermissionsState();
        if (active && reading === revision && !pending) {
          record(state);
        }
        return state !== null;
      } catch (error) {
        if (reading === revision && !pending) {
          failed(error);
        }
        return false;
      }
    };
    const poll = async () => {
      const generation = pollGeneration;
      const available = await read();
      if (active && available && generation === pollGeneration) {
        timer = setTimeout(() => {
          void poll();
        }, 2_000);
      }
    };
    const unsubscribe = subscribeToSystemPermissions((state) => {
      revision += 1;
      if (!pending) {
        record(state);
      }
    });
    void poll();
    enableRef.current = () => {
      if (!active || pending || kind === null) {
        return;
      }
      clearTimeout(timer);
      pending = true;
      revision += 1;
      pollGeneration += 1;
      setAction({ kind, phase: "requesting" });
      void (async () => {
        try {
          const permissions = await getSystemPermissionsState();
          if (!active) {
            return;
          }
          if (!permissions) {
            record(null);
            return;
          }
          const item = permissions[kind];
          if (
            item.status === "granted" ||
            item.status === "restricted"
          ) {
            record(permissions);
            return;
          }
          const result = companionIntroOpensSettings(kind, item)
            ? await openSystemPermissionSettings(kind)
            : await requestSystemPermission(kind);
          record(result ? { ...permissions, [kind]: result } : null);
        } catch (error) {
          failed(error);
        } finally {
          pending = false;
          if (active) {
            timer = setTimeout(() => {
              void poll();
            }, 2_000);
          }
        }
      })();
    };
    return () => {
      active = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [kind, tourActive]);

  if (kind === null || permissions === null) {
    return null;
  }
  return {
    kind,
    state:
      action?.kind === kind
        ? { phase: action.phase }
        : permissions
          ? { phase: "known", item: permissions[kind] }
          : { phase: "checking" },
    enable: () => enableRef.current(),
  };
}
