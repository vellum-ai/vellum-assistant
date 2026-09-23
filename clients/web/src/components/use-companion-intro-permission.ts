import { useEffect, useRef, useState } from "react";

import type {
  CompanionIntroBeat,
  PermissionSourceRect,
} from "@vellumai/ipc-contract";

import {
  beginPermissionGuide,
  cancelPermissionGuide,
  supportsPermissionSetup,
} from "@/runtime/permission-setup";
import { captureError } from "@/lib/sentry/capture-error";
import { ensureMainWindowVisible } from "@/runtime/main-window";
import { frontmostApp } from "@/runtime/running-apps";
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
type CompanionIntroPermissionState =
  | { phase: "checking" | "requesting" | "error" }
  | { phase: "known"; item: SystemPermissionStateItem };

export interface CompanionIntroPermission {
  kind: CompanionIntroPermissionKind;
  state: CompanionIntroPermissionState;
  enable: (source?: PermissionSourceRect) => void;
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

const PERMISSION_FOR_BEAT: Partial<
  Record<CompanionIntroBeat, CompanionIntroPermissionKind>
> = {
  try: "microphone",
  key: "inputMonitoring",
  share: "screen",
};

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
  const kind = beat === null ? null : (PERMISSION_FOR_BEAT[beat] ?? null);
  const tourActive = beat !== null;
  const [permissions, setPermissions] = useState<
    SystemPermissionsState | null | undefined
  >(undefined);
  const [action, setAction] = useState<{
    kind: CompanionIntroPermissionKind;
    phase: "requesting" | "error";
  } | null>(null);
  const enableRef = useRef<(source?: PermissionSourceRect) => void>(() => {});

  useEffect(() => {
    setAction(null);
    if (!tourActive) {
      return;
    }
    let active = true;
    let pending = false;
    let revision = 0;
    let reading = false;
    let checkingReturn = false;
    let returnToApp: "waiting" | "ready" | null = null;
    const resumeTour = async () => {
      if (!active || pending || checkingReturn || returnToApp !== "ready") {
        return;
      }
      checkingReturn = true;
      try {
        // The grant can precede Settings' Quit & Reopen confirmation.
        const frontmost = await frontmostApp();
        if (
          !active ||
          pending ||
          returnToApp !== "ready" ||
          frontmost === null ||
          frontmost === "com.apple.systempreferences" ||
          frontmost === "com.apple.SecurityAgent"
        ) {
          return;
        }
        returnToApp = null;
        cancelPermissionGuide();
        await ensureMainWindowVisible();
      } catch (error) {
        captureError(error, { context: "companionIntro.resumeAfterPermission" });
      } finally {
        checkingReturn = false;
      }
    };
    const record = (
      state: SystemPermissionsState | null,
      keepRequestPending = false,
    ) => {
      if (!active) {
        return;
      }
      setPermissions((previous) => {
        if (JSON.stringify(previous) === JSON.stringify(state)) {
          return previous;
        }
        return state;
      });
      if (!keepRequestPending) {
        setAction(null);
      }
      if (returnToApp !== null && kind !== null) {
        returnToApp = state
          ? state[kind].status === "granted"
            ? "ready"
            : "waiting"
          : null;
        void resumeTour();
      }
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
      if (reading || pending) {
        return;
      }
      reading = true;
      const started = revision;
      try {
        const state = await getSystemPermissionsState();
        if (active && started === revision && !pending) {
          record(state);
        }
        if (state === null) {
          clearInterval(timer);
        }
      } catch (error) {
        if (started === revision && !pending) {
          failed(error);
        }
      } finally {
        reading = false;
      }
    };
    const timer = setInterval(() => {
      void read();
    }, 2_000);
    const unsubscribe = subscribeToSystemPermissions((state) => {
      revision += 1;
      record(state, pending);
    });
    void read();
    enableRef.current = (source) => {
      if (!active || pending || kind === null) {
        return;
      }
      pending = true;
      revision += 1;
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
          if (item.status === "granted" || item.status === "restricted") {
            record(permissions);
            return;
          }
          const requesting = revision;
          returnToApp = "waiting";
          const result =
            kind !== "microphone" && supportsPermissionSetup()
              ? await beginPermissionGuide(kind, source)
              : companionIntroOpensSettings(kind, item)
                ? await openSystemPermissionSettings(kind)
                : await requestSystemPermission(kind);
          if (active) {
            if (requesting === revision) {
              record(result ? { ...permissions, [kind]: result } : null);
            } else {
              setAction(null);
            }
          }
        } catch (error) {
          returnToApp = null;
          failed(error);
        } finally {
          pending = false;
          void resumeTour();
        }
      })();
    };
    return () => {
      active = false;
      cancelPermissionGuide();
      clearInterval(timer);
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
    enable: (source) => enableRef.current(source),
  };
}
