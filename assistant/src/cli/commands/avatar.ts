import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";
import { avatarHelp } from "./avatar.help.js";

// Types returned by IPC routes
interface CharacterComponents {
  bodyShapes: Array<{ id: string }>;
  eyeStyles: Array<{ id: string }>;
  colors: Array<{ id: string; hex: string }>;
}

export function registerAvatarCommand(program: Command): void {
  registerCommand(program, {
    name: avatarHelp.name,
    transport: "ipc",
    description: avatarHelp.description,
    build: (avatar) => {
      applyCommandHelp(avatar, avatarHelp);

      // ── generate ─────────────────────────────────────────────────────
      subcommand(avatar, "generate").action(
        async (opts: { description: string }, cmd: Command) => {
          const r = await cliIpcCall<{ ok: boolean; message: string }>(
            "avatar_generate",
            { body: { description: opts.description } },
          );
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          log.info(r.result!.message);
        },
      );

      // ── set ──────────────────────────────────────────────────────────
      subcommand(avatar, "set").action(
        async (opts: { image: string }, cmd: Command) => {
          const resolvedSource = isAbsolute(opts.image)
            ? opts.image
            : join(
                process.env.VELLUM_WORKSPACE_DIR ||
                  join(homedir(), ".vellum", "workspace"),
                opts.image,
              );

          if (!existsSync(resolvedSource)) {
            log.error(`Image file not found: ${resolvedSource}`);
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{ ok: boolean }>("avatar_set", {
            body: { imagePath: resolvedSource },
          });
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          log.info(`Avatar set from: ${resolvedSource}`);
        },
      );

      // ── remove ───────────────────────────────────────────────────────
      subcommand(avatar, "remove").action(
        async (_opts: object, cmd: Command) => {
          const r = await cliIpcCall<{ ok: boolean; hadAvatar: boolean }>(
            "avatar_remove",
          );
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          if (!r.result!.hadAvatar) {
            log.info("No custom avatar to remove — already using the default.");
          } else {
            log.info("Custom avatar removed.");
          }
        },
      );

      // ── get ──────────────────────────────────────────────────────────
      subcommand(avatar, "get").action(
        async (opts: { format: string }, cmd: Command) => {
          if (opts.format !== "path" && opts.format !== "base64") {
            log.error(
              `Invalid format: "${opts.format}". Must be "path" or "base64".`,
            );
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{
            exists: boolean;
            path?: string;
            base64?: string;
          }>("avatar_get", { body: { format: opts.format } });
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          if (!r.result!.exists) {
            log.info(
              "No avatar is currently set — no custom image and no character traits found.",
            );
            return;
          }

          if (opts.format === "path") {
            process.stdout.write(r.result!.path! + "\n");
          } else {
            process.stdout.write(r.result!.base64! + "\n");
          }
        },
      );

      // ── character ────────────────────────────────────────────────────
      const character = subcommand(avatar, "character");

      subcommand(character, "update").action(
        async (
          opts: { bodyShape: string; eyeStyle: string; color: string },
          cmd: Command,
        ) => {
          const r = await cliIpcCall<{ ok: boolean }>(
            "avatar_render_from_traits",
            {
              body: {
                bodyShape: opts.bodyShape,
                eyeStyle: opts.eyeStyle,
                color: opts.color,
              },
            },
          );
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          log.info(
            `Avatar updated: ${opts.bodyShape} body, ${opts.eyeStyle} eyes, ${opts.color} color`,
          );
        },
      );

      subcommand(character, "components").action(
        async (opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<CharacterComponents>(
            "avatar_character_components",
          );
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );

          if (opts.json) {
            writeOutput(cmd, r.result);
            return;
          }

          const components = r.result!;
          log.info("Body shapes:");
          for (const shape of components.bodyShapes) {
            log.info(`  ${shape.id}`);
          }

          log.info("");
          log.info("Eye styles:");
          for (const style of components.eyeStyles) {
            log.info(`  ${style.id}`);
          }

          log.info("");
          log.info("Colors:");
          for (const color of components.colors) {
            log.info(`  ${color.id} (${color.hex})`);
          }
        },
      );

      subcommand(character, "ascii").action(
        async (opts: { width: string }, cmd: Command) => {
          if (!/^\d+$/.test(opts.width)) {
            log.error(
              `Invalid width: "${opts.width}". Must be a positive integer.`,
            );
            process.exitCode = 1;
            return;
          }
          const w = parseInt(opts.width, 10);
          if (!Number.isFinite(w) || w < 1) {
            log.error(
              `Invalid width: "${opts.width}". Must be a positive integer.`,
            );
            process.exitCode = 1;
            return;
          }

          const r = await cliIpcCall<{ ascii: string }>(
            "avatar_character_ascii",
            { body: { width: opts.width } },
          );
          if (!r.ok)
            return exitFromIpcResult(
              r as { ok: false; error?: string; statusCode?: number },
              cmd,
            );
          process.stdout.write(r.result!.ascii + "\n");
        },
      );
    },
  });
}
