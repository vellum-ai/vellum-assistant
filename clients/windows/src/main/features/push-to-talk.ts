import { app } from "electron";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HELPER_HOTKEY_EVENT,
  HELPER_HOTKEY_REGISTRATION_EVENT,
  HELPER_HOTKEY_SET_PTT,
  type HotkeyEvent,
  type PushToTalkActivator,
  type PushToTalkRegistrationResult,
} from "@vellumai/ipc-contract";

import { handle } from "../ipc.client";
import log from "../logger";
import { current } from "../main-window";
import { getWindowsHelperClient } from "../windows-helper";

const modifierSchema = z.enum([
  "function",
  "control",
  "shift",
  "option",
  "command",
]);
const activatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("off") }),
  z.object({
    kind: z.literal("modifierOnly"),
    modifiers: z.array(modifierSchema),
  }),
  z.object({
    kind: z.literal("key"),
    label: z.string().min(1),
    modifiers: z.array(modifierSchema),
  }),
]);
const resultSchema = z.union([
  z.object({ ok: z.literal(true), enabled: z.boolean() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
const eventSchema = z.object({ state: z.enum(["down", "up"]) });

let owner: Electron.WebContents | null = null;
let pressed = false;
let registeredActivator: PushToTalkActivator | null = null;

const sendState = (state: HotkeyEvent["state"]): void => {
  if (!owner || owner.isDestroyed()) {
    owner = null;
    pressed = false;
    return;
  }
  owner.send(HELPER_HOTKEY_EVENT, { kind: "pushToTalk", state });
  pressed = state === "down";
};

const sendRegistrationState = (active: boolean): void => {
  if (!owner || owner.isDestroyed()) {
    owner = null;
    pressed = false;
    return;
  }
  owner.send(HELPER_HOTKEY_REGISTRATION_EVENT, active);
};

const feature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "push-to-talk",
  install: () => {
    const helper = getWindowsHelperClient();
    helper.onNotification("hotkey.pushToTalk", eventSchema, ({ state }) => {
      sendState(state);
    });
    helper.onState((state) => {
      if (state.status !== "running") {
        if (pressed) {
          sendState("up");
        }
        sendRegistrationState(false);
      }
      if (
        state.status === "running" &&
        registeredActivator &&
        owner &&
        !owner.isDestroyed()
      ) {
        void helper
          .call("hotkey.setPushToTalk", { activator: registeredActivator })
          .then((value) => {
            const result = resultSchema.parse(value);
            sendRegistrationState(result.ok && result.enabled);
          })
          .catch((error: unknown) => {
            sendRegistrationState(false);
            log.warn("[push-to-talk] failed to restore binding:", error);
          });
      }
    });

    handle(
      HELPER_HOTKEY_SET_PTT,
      z.tuple([activatorSchema.nullable()]),
      async ([activator], event): Promise<PushToTalkRegistrationResult> => {
        if (event.sender !== current()?.webContents) {
          return { ok: false, reason: "Main window owns push-to-talk" };
        }
        if (pressed) {
          sendState("up");
        }
        owner = activator ? event.sender : null;
        registeredActivator = activator;
        let result: PushToTalkRegistrationResult;
        try {
          result = resultSchema.parse(
            await helper.call("hotkey.setPushToTalk", { activator }),
          );
        } catch (error) {
          sendRegistrationState(false);
          throw error;
        }
        if (!result.ok) {
          owner = null;
          registeredActivator = null;
          return result;
        }
        owner = result.enabled ? event.sender : null;
        registeredActivator = result.enabled ? activator : null;
        return result;
      },
    );

    // The dictation feature owns the helper's graceful shutdown.
    app.once("before-quit", () => {
      owner = null;
      pressed = false;
      registeredActivator = null;
    });
  },
};

export default feature;
