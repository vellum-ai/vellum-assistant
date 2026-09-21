import { useEffect, useRef, useState } from "react";

import type { CompanionIntroBeat } from "@vellumai/ipc-contract";

import { captureError } from "@/lib/sentry/capture-error";
import {
  getSystemPermissionsState,
  openSystemPermissionSettings,
  requestSystemPermission,
  subscribeToSystemPermissions,
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
  const [snapshot, setSnapshot] = useState<{
    kind: CompanionIntroPermissionKind;
    state: CompanionIntroPermissionState | null;
  } | null>(null);
  const enableRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (kind === null) {
      return;
    }
    let active = true;
    let pending = false;
    let revision = 0;
    let pollGeneration = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const record = (state: CompanionIntroPermissionState | null) => {
      if (!active) {
        return;
      }
      setSnapshot((previous) => {
        if (
          previous?.kind === kind &&
          JSON.stringify(previous.state) === JSON.stringify(state)
        ) {
          return previous;
        }
        return { kind, state };
      });
    };
    const failed = (error: unknown) => {
      if (active) {
        record({ phase: "error" });
        captureError(error, {
          context: "companionIntro.permission",
          tags: { kind },
        });
      }
    };
    const read = async () => {
      const reading = revision;
      try {
        const state = await getSystemPermissionsState();
        if (active && reading === revision && !pending) {
          record(state === null ? null : { phase: "known", item: state[kind] });
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
        record({ phase: "known", item: state[kind] });
      }
    });
    record({ phase: "checking" });
    void poll();
    enableRef.current = () => {
      if (!active || pending) {
        return;
      }
      clearTimeout(timer);
      pending = true;
      revision += 1;
      pollGeneration += 1;
      record({ phase: "requesting" });
      void (async () => {
        try {
          const permissions = await getSystemPermissionsState();
          if (!active) {
            return;
          }
          const item = permissions?.[kind];
          if (
            !item ||
            item.status === "granted" ||
            item.status === "restricted"
          ) {
            record(item ? { phase: "known", item } : null);
            return;
          }
          const result =
            item.status === "denied" || !item.canRequest
              ? await openSystemPermissionSettings(kind)
              : await requestSystemPermission(kind);
          record(result ? { phase: "known", item: result } : null);
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
  }, [kind]);

  if (kind === null || (snapshot?.kind === kind && snapshot.state === null)) {
    return null;
  }
  return {
    kind,
    state: (snapshot?.kind === kind ? snapshot.state : null) ?? {
      phase: "checking",
    },
    enable: () => enableRef.current(),
  };
}
