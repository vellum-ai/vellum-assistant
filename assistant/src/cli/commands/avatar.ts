import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";

// Types returned by IPC routes
interface CharacterComponents {
  bodyShapes: Array<{ id: string }>;
  eyeStyles: Array<{ id: string }>;
  colors: Array<{ id: string; hex: string }>;
}

export function registerAvatarCommand(program: Command): void {
  registerCommand(program, {
    name: "avatar",
    transport: "ipc",
    description: "Manage the assistant's avatar",
    build: (avatar) => {
      avatar.addHelpText(
        "after",
        `
The avatar system supports two modes:

  1. Native character — a procedurally generated character with configurable
     body shape, eye style, and color. The character is rendered as both a
     PNG image and ASCII art. Use the "character" subcommand group to manage
     native character avatars.

  2. Custom image — an externally provided image file set via the "set"
     subcommand, or generated via "generate".

Files are stored in $VELLUM_WORKSPACE_DIR/data/avatar/:
  character-traits.json   Current trait selection (bodyShape, eyeStyle, color)
  avatar-image.png        Rendered PNG of the character
  character-ascii.txt     ASCII art representation (best-effort; may not be written)

Examples:
  $ assistant avatar set --image /path/to/photo.png
  $ assistant avatar remove
  $ assistant avatar get --format base64
  $ assistant avatar character update --body-shape blob --eye-style curious --color green
  $ assistant avatar generate --description "a cute blue cat"`,
      );

      avatar
        .command("generate")
        .description("Generate an AI avatar from a text description")
        .requiredOption(
          "--description <text>",
          "Description of the avatar to generate",
        )
        .addHelpText(
          "after",
          `
Generates an avatar image using AI based on the provided text description
and saves it as the assistant's avatar PNG. This replaces any existing
native character avatar — the character traits and ASCII files are removed.

On success, writes avatar-image.png to $VELLUM_WORKSPACE_DIR/data/avatar/
and removes character-traits.json and character-ascii.txt if they exist.

Examples:
  $ assistant avatar generate --description "a cute blue cat"
  $ assistant avatar generate --description "a friendly robot with green eyes"`,
        )
        .action(async (opts: { description: string }, cmd: Command) => {
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
        });

      avatar
        .command("set")
        .description(
          "Set the assistant's avatar from an image file (removes any native character)",
        )
        .requiredOption(
          "--image <path>",
          "Path to image file (absolute or relative to workspace)",
        )
        .addHelpText(
          "after",
          `
Sets the assistant's avatar by copying the provided image file to the
canonical avatar location. This REPLACES any existing avatar and removes
any configured native character: character-traits.json (and character-ascii.txt)
are deleted, so a previously configured character is NOT preserved and cannot
be restored. Rebuild the character with "assistant avatar character update"
to reconfigure one.

The --image path can be absolute or relative to the workspace directory.

Examples:
  $ assistant avatar set --image /path/to/photo.png
  $ assistant avatar set --image conversations/abc123/attachments/Dropped\\ Image.png`,
        )
        .action(async (opts: { image: string }, cmd: Command) => {
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
        });

      avatar
        .command("remove")
        .description("Reset the avatar to none (clears image and character)")
        .addHelpText(
          "after",
          `
Resets the avatar to its empty state. This deletes ALL avatar artifacts —
the custom image (avatar-image.png) AND any configured native character
(character-traits.json / character-ascii.txt) — and marks the avatar as
"none".

This is destructive: a previously configured native character is NOT
preserved and will not be restored. Rebuild the character (or set a new
image) to configure an avatar again.

Examples:
  $ assistant avatar remove`,
        )
        .action(async (_opts: object, cmd: Command) => {
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
        });

      avatar
        .command("get")
        .description("Retrieve the current avatar")
        .option("--format <format>", "Output format: path or base64", "path")
        .addHelpText(
          "after",
          `
Retrieves the current avatar. By default prints the absolute file path;
with --format base64, prints the base64-encoded image content.

If no avatar image exists but character-traits.json is present, the PNG
is regenerated from the saved traits before output.

Examples:
  $ assistant avatar get
  $ assistant avatar get --format path
  $ assistant avatar get --format base64`,
        )
        .action(async (opts: { format: string }, cmd: Command) => {
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
        });

      const character = avatar
        .command("character")
        .description("Manage the native character avatar");

      character.addHelpText(
        "after",
        `
A native character avatar is composed of three traits:
  - body shape: the silhouette of the character (e.g. blob, cloud, star)
  - eye style: the expression of the character's eyes (e.g. curious, gentle)
  - color: the body fill color (e.g. green, purple, teal)

Use "character components" to list all available values for each trait.
Use "character update" to set traits and regenerate the avatar files.
Use "character ascii" to preview the current character in the terminal.

Examples:
  $ assistant avatar character update --body-shape blob --eye-style curious --color green
  $ assistant avatar character components --json
  $ assistant avatar character ascii --width 40`,
      );

      character
        .command("update")
        .description("Set character traits and regenerate avatar")
        .requiredOption(
          "--body-shape <shape>",
          "Body shape (e.g. blob, cloud, star)",
        )
        .requiredOption(
          "--eye-style <style>",
          "Eye style (e.g. curious, gentle, goofy)",
        )
        .requiredOption(
          "--color <color>",
          "Body color (e.g. green, purple, teal)",
        )
        .addHelpText(
          "after",
          `
Sets the three character traits and regenerates avatar files (PNG image,
traits JSON, and optionally ASCII art). Each trait value must be a valid ID from the
component set — use "assistant avatar character components" to list valid IDs.

The --body-shape flag sets the character silhouette. Valid values:
  blob, cloud, sprout, star, ghost, urchin, stack, flower, burst, ninja

The --eye-style flag sets the eye expression. Valid values:
  grumpy, angry, curious, goofy, surprised, bashful, gentle, quirky, dazed

The --color flag sets the body fill color. Valid values:
  green, orange, pink, purple, teal, yellow

On success, writes character-traits.json and avatar-image.png to
$VELLUM_WORKSPACE_DIR/data/avatar/. character-ascii.txt is written on a
best-effort basis and may be skipped if ASCII rendering fails.

Examples:
  $ assistant avatar character update --body-shape blob --eye-style curious --color green
  $ assistant avatar character update --body-shape star --eye-style goofy --color purple
  $ assistant avatar character update --body-shape ghost --eye-style gentle --color teal`,
        )
        .action(
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

      character
        .command("components")
        .description("List available character traits")
        .option("--json", "Machine-readable JSON output")
        .addHelpText(
          "after",
          `
Lists all available values for each character trait: body shapes, eye styles,
and colors. Each value is shown with its ID (the string you pass to
"character update").

With --json, outputs the full components object including SVG path data,
viewBox dimensions, and face-center coordinates — useful for programmatic
consumption.

Without --json, prints a human-readable summary of IDs only.

Examples:
  $ assistant avatar character components
  $ assistant avatar character components --json`,
        )
        .action(async (opts: { json?: boolean }, cmd: Command) => {
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
        });

      character
        .command("ascii")
        .description("Print the current character as ASCII art")
        .option("--width <n>", "Output width in characters", "60")
        .addHelpText(
          "after",
          `
Reads the current character traits from character-traits.json and renders
the character as ASCII art to stdout. The output uses a brightness ramp
optimized for dark terminal backgrounds.

The --width flag controls the number of characters per line (default: 60).
Terminal cells are roughly twice as tall as they are wide, so the renderer
compensates automatically — a 60-character-wide output will look correctly
proportioned in most terminals.

If no character has been set yet, prints an error and suggests using
"assistant avatar character update" first.

Examples:
  $ assistant avatar character ascii
  $ assistant avatar character ascii --width 40
  $ assistant avatar character ascii --width 80`,
        )
        .action(async (opts: { width: string }, cmd: Command) => {
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
        });
    },
  });
}
