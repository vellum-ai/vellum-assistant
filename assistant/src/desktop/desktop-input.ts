import { execFile } from "node:child_process";

import { z } from "zod";

import {
  DESKTOP_DISPLAY,
  DESKTOP_INPUT_PARAMETERS,
} from "./desktop-display.js";
import { desktopScreenshot } from "./desktop-screenshot.js";

const point = { x: z.number().int().min(0), y: z.number().int().min(0) };
const observed = { observation_id: z.string().uuid() };
export const desktopActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("observe") }),
  z.object({ action: z.literal("done") }),
  z.object({
    action: z.literal("click"),
    ...observed,
    ...point,
    button: z.enum(["left", "right", "middle", "double"]).default("left"),
  }),
  z.object({
    action: z.literal("type"),
    ...observed,
    text: z.string().min(1).max(10_000),
  }),
  z.object({
    action: z.literal("key"),
    ...observed,
    key: z
      .string()
      .regex(/^[a-zA-Z0-9_+]+$/)
      .max(100),
  }),
  z.object({
    action: z.literal("scroll"),
    ...observed,
    ...point,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).default(3),
  }),
  z.object({
    action: z.literal("drag"),
    ...observed,
    ...point,
    to_x: z.number().int().min(0),
    to_y: z.number().int().min(0),
  }),
]);
export type DesktopAction = z.infer<typeof desktopActionSchema>;
export type DesktopObservation = { png: Buffer; width: number; height: number };

export interface DesktopInput {
  observe(signal: AbortSignal): Promise<DesktopObservation>;
  perform(action: DesktopAction, signal: AbortSignal): Promise<void>;
  setViewerInput(enabled: boolean): Promise<void>;
  releaseInput(): Promise<void>;
}

export function runDesktopCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
  input?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      `/usr/bin/${command}`,
      args,
      {
        env: {
          PATH: "/usr/bin:/bin",
          DISPLAY: DESKTOP_DISPLAY,
          LANG: "C.UTF-8",
        },
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
        killSignal: "SIGKILL",
        windowsHide: true,
        signal,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export class X11DesktopInput implements DesktopInput {
  async observe(signal: AbortSignal): Promise<DesktopObservation> {
    return desktopScreenshot(
      await runDesktopCommand("xwd", ["-root", "-silent"], signal),
    );
  }

  async perform(action: DesktopAction, signal: AbortSignal): Promise<void> {
    const run = (...args: string[]) =>
      runDesktopCommand("xdotool", args, signal);
    if ("x" in action) {
      const geometry = (await run("getdisplaygeometry"))
        .toString()
        .trim()
        .split(/\s+/)
        .map(Number);
      const valid = (x: number, y: number) =>
        x < geometry[0]! && y < geometry[1]!;
      if (
        !valid(action.x, action.y) ||
        (action.action === "drag" && !valid(action.to_x, action.to_y))
      ) {
        throw new Error(
          "Desktop dimensions changed or coordinates are out of bounds. Observe again.",
        );
      }
      await run("mousemove", "--sync", String(action.x), String(action.y));
    }
    switch (action.action) {
      case "click":
        await run(
          "click",
          "--clearmodifiers",
          "--repeat",
          action.button === "double" ? "2" : "1",
          "--delay",
          "100",
          { left: "1", double: "1", middle: "2", right: "3" }[action.button],
        );
        break;
      case "type":
        await runDesktopCommand(
          "xdotool",
          ["type", "--clearmodifiers", "--delay", "1", "--file", "-"],
          signal,
          action.text,
        );
        break;
      case "key":
        await run("key", "--clearmodifiers", action.key);
        break;
      case "scroll":
        await run(
          "click",
          "--clearmodifiers",
          "--repeat",
          String(action.amount),
          "--delay",
          "50",
          { up: "4", down: "5", left: "6", right: "7" }[action.direction],
        );
        break;
      case "drag":
        await run("mousedown", "1");
        await run(
          "mousemove",
          "--sync",
          String(action.to_x),
          String(action.to_y),
        );
        await run("mouseup", "1");
        break;
    }
  }

  async setViewerInput(enabled: boolean): Promise<void> {
    const value = enabled ? "1" : "0";
    await runDesktopCommand("tigervncconfig", [
      "-set",
      ...DESKTOP_INPUT_PARAMETERS.map((name) => `${name}=${value}`),
    ]);
    for (const name of DESKTOP_INPUT_PARAMETERS) {
      const actual = await runDesktopCommand("tigervncconfig", ["-get", name]);
      if (
        !new Set(enabled ? ["1", "true", "on"] : ["0", "false", "off"]).has(
          actual.toString().trim().toLowerCase(),
        )
      ) {
        throw new Error(`Could not update desktop input: ${name}`);
      }
    }
  }

  async releaseInput(): Promise<void> {
    // Zero padding makes xdotool interpret every value as a keycode, including 8 and 9.
    await runDesktopCommand("xdotool", [
      "keyup",
      "--delay",
      "0",
      ...Array.from({ length: 248 }, (_, index) =>
        String(index + 8).padStart(3, "0"),
      ),
      "mouseup",
      "1",
      "mouseup",
      "2",
      "mouseup",
      "3",
    ]);
  }
}
