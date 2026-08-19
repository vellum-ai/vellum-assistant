import { app } from "electron";
import { z } from "zod";

import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@vellumai/electron-desktop/capability-registry";
import {
  HELPER_HOTKEY_EVENT,
  HELPER_HOTKEY_SET_PTT,
  type HotkeyEvent,
  type PushToTalkRegistrationResult,
} from "@vellumai/ipc-contract";

import { handle } from "../ipc.client";
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

const sendState = (state: HotkeyEvent["state"]): void => {
  if (!owner || owner.isDestroyed()) {
    owner = null;
    pressed = false;
    return;
  }
  owner.send(HELPER_HOTKEY_EVENT, { kind: "pushToTalk", state });
  pressed = state === "down";
};

const feature: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "push-to-talk",
  install: () => {
    const helper = getWindowsHelperClient();
    helper.onNotification("hotkey.pushToTalk", eventSchema, ({ state }) => {
      sendState(state);
    });
    helper.onState((state) => {
      if (state.status !== "running" && pressed) {
        sendState("up");
      }
    });

    handle(
      HELPER_HOTKEY_SET_PTT,
      z.tuple([activatorSchema.nullable()]),
      async ([activator], event): Promise<PushToTalkRegistrationResult> => {
        const result = resultSchema.parse(
          await helper.call("hotkey.setPushToTalk", { activator }),
        );
        if (result.ok) {
          if (pressed) {
            sendState("up");
          }
          owner = result.enabled ? event.sender : null;
        }
        return result;
      },
    );

    app.once("before-quit", () => {
      owner = null;
      pressed = false;
      helper.shutdown();
    });
  },
};

export default feature;
