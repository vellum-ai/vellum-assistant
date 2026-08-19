import { afterEach, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PushToTalkActivator } from "@vellumai/ipc-contract";

import { useNativePushToTalkRegistration } from "@/domains/chat/voice/use-native-push-to-talk-registration";
import {
  CTRL_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  pushToTalkActivation,
  serializeActivator,
} from "@/utils/ptt-activator";
import { setLocalSetting } from "@/utils/local-settings";
import { isConfigurablePushToTalkActive } from "@/runtime/hotkey";
import { withRejectedWrites } from "@/utils/rejected-writes.test-helper";

afterEach(() => {
  cleanup();
  delete window.vellum;
  pushToTalkActivation.save({ kind: "off" });
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

test("disables configurable push-to-talk in popouts", async () => {
  const registrations: unknown[] = [];
  window.history.replaceState({}, "", "/?popout=1");
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        setPushToTalk: async (activator: PushToTalkActivator | null) => {
          registrations.push(activator);
          return { ok: true, enabled: activator !== null };
        },
        onEvent: () => () => undefined,
      },
    },
  } as unknown as typeof window.vellum;

  renderHook(() => useNativePushToTalkRegistration());

  expect(registrations).toHaveLength(0);
  expect(isConfigurablePushToTalkActive()).toBe(true);
});

test("leaves the Talk control as the sole Fn owner", () => {
  const registrations: boolean[] = [];
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        fnPushToTalk: async (enabled: boolean) => {
          registrations.push(enabled);
          return { ok: true, enabled };
        },
        onEvent: () => () => undefined,
      },
    },
  } as unknown as typeof window.vellum;

  renderHook(() => useNativePushToTalkRegistration());

  expect(registrations).toHaveLength(0);
});

test("preserves a legacy Space binding as a focused key activator", async () => {
  const registrations: Array<PushToTalkActivator | null> = [];
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        setPushToTalk: async (activator: PushToTalkActivator | null) => {
          registrations.push(activator);
          return { ok: false, reason: "modifier-only" };
        },
        onEvent: () => () => undefined,
        onRegistrationChange: () => () => undefined,
      },
    },
  } as unknown as typeof window.vellum;
  localStorage.setItem(LS_PTT_ACTIVATION_KEY, "Space");

  renderHook(() => useNativePushToTalkRegistration());

  await waitFor(() => expect(registrations).toHaveLength(1));
  expect(registrations[0]).toEqual({
    kind: "key",
    label: " ",
    modifiers: [],
  });
  expect(isConfigurablePushToTalkActive()).toBe(false);
});

test("retries a prior chord after a failed binding change", async () => {
  const registrations: unknown[] = [];
  let registrationListener = (_active: boolean): void => undefined;
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        setPushToTalk: async (activator: PushToTalkActivator | null) => {
          registrations.push(activator);
          if (
            activator?.kind === "modifierOnly" &&
            activator.modifiers.includes("option")
          ) {
            return { ok: false, reason: "unavailable" };
          }
          return { ok: true, enabled: activator !== null };
        },
        onEvent: () => () => undefined,
        onRegistrationChange: (listener: (active: boolean) => void) => {
          registrationListener = listener;
          return () => {
            registrationListener = () => undefined;
          };
        },
      },
    },
  } as unknown as typeof window.vellum;
  localStorage.setItem(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator(CTRL_PTT_ACTIVATOR),
  );
  renderHook(() => useNativePushToTalkRegistration());
  await waitFor(() => expect(registrations).toHaveLength(1));
  expect(isConfigurablePushToTalkActive()).toBe(true);
  registrationListener(false);
  expect(isConfigurablePushToTalkActive()).toBe(false);

  setLocalSetting(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator({ kind: "modifierOnly", modifiers: ["option"] }),
  );
  await waitFor(() => expect(registrations).toHaveLength(2));

  setLocalSetting(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator(CTRL_PTT_ACTIVATOR),
  );
  await waitFor(() => expect(registrations).toHaveLength(3));
  expect(registrations[2]).toEqual(CTRL_PTT_ACTIVATOR);
});

test("registers the latest binding after an in-flight failure", async () => {
  const registrations: Array<PushToTalkActivator | null> = [];
  let rejectOption = (): void => undefined;
  const optionResult = new Promise<{ ok: boolean; reason: string }>((resolve) => {
    rejectOption = () => resolve({ ok: false, reason: "unavailable" });
  });
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        setPushToTalk: async (activator: PushToTalkActivator | null) => {
          registrations.push(activator);
          if (
            activator?.kind === "modifierOnly" &&
            activator.modifiers.includes("option")
          ) {
            return optionResult;
          }
          return { ok: true, enabled: activator !== null };
        },
        onEvent: () => () => undefined,
        onRegistrationChange: () => () => undefined,
      },
    },
  } as unknown as typeof window.vellum;
  localStorage.setItem(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator(CTRL_PTT_ACTIVATOR),
  );
  renderHook(() => useNativePushToTalkRegistration());
  await waitFor(() => expect(registrations).toHaveLength(1));

  setLocalSetting(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator({ kind: "modifierOnly", modifiers: ["option"] }),
  );
  await waitFor(() => expect(registrations).toHaveLength(2));
  setLocalSetting(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator({
      kind: "modifierOnly",
      modifiers: ["control", "shift"],
    }),
  );

  rejectOption();
  await waitFor(() => expect(registrations).toHaveLength(3));
  expect(registrations[2]).toEqual({
    kind: "modifierOnly",
    modifiers: ["control", "shift"],
  });
});

test("applies a binding in memory when storage rejects the write", async () => {
  const registrations: Array<PushToTalkActivator | null> = [];
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        setPushToTalk: async (activator: PushToTalkActivator | null) => {
          registrations.push(activator);
          return { ok: true, enabled: activator !== null };
        },
        onEvent: () => () => undefined,
        onRegistrationChange: () => () => undefined,
      },
    },
  } as unknown as typeof window.vellum;
  renderHook(() => useNativePushToTalkRegistration());
  await waitFor(() => expect(registrations).toHaveLength(1));

  const optionActivator = {
    kind: "modifierOnly" as const,
    modifiers: ["option" as const],
  };
  withRejectedWrites(() => pushToTalkActivation.save(optionActivator));

  await waitFor(() => expect(registrations).toHaveLength(2));
  expect(registrations[1]).toEqual(optionActivator);
});
