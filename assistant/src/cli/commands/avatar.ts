import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Command } from "commander";

import { renderCharacterAscii } from "../../avatar/ascii-renderer.js";
import { getCharacterComponents } from "../../avatar/character-components.js";
import {
  type CharacterTraits,
  writeTraitsAndRenderAvatar,
} from "../../avatar/traits-png-sync.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { log } from "../logger.js";
import { writeOutput } from "../output.js";

export function registerAvatarCommand(program: Command): void {
  const avatar = program
    .command("avatar")
    .description("Manage the assistant's avatar");

  avatar.addHelpText(
    "after",
    `
The avatar system supports two modes:

  1. Native character — a procedurally generated character with configurable
     body shape, eye style, and color. The character is rendered as both a
     PNG image and ASCII art. Use the "character" subcommand group to manage
     native character avatars.

  2. Custom image — an externally provided image file placed directly in the
     avatar directory. Custom images are not managed through this CLI.

Files are stored in ~/.vellum/workspace/data/avatar/:
  character-traits.json   Current trait selection (bodyShape, eyeStyle, color)
  avatar-image.png        Rendered PNG of the character
  character-ascii.txt     ASCII art representation of the character

Examples:
  $ assistant avatar character update --body-shape blob --eye-style curious --color green
  $ assistant avatar character components
  $ assistant avatar character ascii`,
  );

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
    .requiredOption("--color <color>", "Body color (e.g. green, purple, teal)")
    .addHelpText(
      "after",
      `
Sets the three character traits and regenerates all avatar files (PNG image,
ASCII art, and traits JSON). Each trait value must be a valid ID from the
component set — use "assistant avatar character components" to list valid IDs.

The --body-shape flag sets the character silhouette. Valid values:
  blob, cloud, sprout, star, ghost, urchin, stack, flower, burst, ninja

The --eye-style flag sets the eye expression. Valid values:
  grumpy, angry, curious, goofy, surprised, bashful, gentle, quirky, dazed

The --color flag sets the body fill color. Valid values:
  green, orange, pink, purple, teal, yellow

On success, writes three files to ~/.vellum/workspace/data/avatar/:
  character-traits.json, avatar-image.png, character-ascii.txt

Examples:
  $ assistant avatar character update --body-shape blob --eye-style curious --color green
  $ assistant avatar character update --body-shape star --eye-style goofy --color purple
  $ assistant avatar character update --body-shape ghost --eye-style gentle --color teal`,
    )
    .action(
      async (opts: { bodyShape: string; eyeStyle: string; color: string }) => {
        const components = getCharacterComponents();

        const validBodyShapes = components.bodyShapes.map((b) => b.id);
        if (!validBodyShapes.includes(opts.bodyShape)) {
          log.error(
            `Invalid body shape: "${opts.bodyShape}". Valid options: ${validBodyShapes.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }

        const validEyeStyles = components.eyeStyles.map((e) => e.id);
        if (!validEyeStyles.includes(opts.eyeStyle)) {
          log.error(
            `Invalid eye style: "${opts.eyeStyle}". Valid options: ${validEyeStyles.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }

        const validColors = components.colors.map((c) => c.id);
        if (!validColors.includes(opts.color)) {
          log.error(
            `Invalid color: "${opts.color}". Valid options: ${validColors.join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }

        const result = writeTraitsAndRenderAvatar({
          bodyShape: opts.bodyShape,
          eyeStyle: opts.eyeStyle,
          color: opts.color,
        });

        if (!result.ok) {
          log.error(
            `Failed to write traits and render avatar: ${result.message}`,
          );
          process.exitCode = 1;
          return;
        }

        const avatarDir = join(getWorkspaceDir(), "data", "avatar");
        log.info(
          `Avatar updated: ${opts.bodyShape} body, ${opts.eyeStyle} eyes, ${opts.color} color`,
        );
        log.info(`Files written to: ${avatarDir}`);
        log.info(`  character-traits.json`);
        log.info(`  avatar-image.png`);
        if (result.asciiWritten) {
          log.info(`  character-ascii.txt`);
        }
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
    .action((opts: { json?: boolean }, cmd: Command) => {
      const components = getCharacterComponents();

      if (opts.json) {
        writeOutput(cmd, components);
        return;
      }

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
    .action(async (opts: { width: string }) => {
      const avatarDir = join(getWorkspaceDir(), "data", "avatar");
      const traitsPath = join(avatarDir, "character-traits.json");

      if (!existsSync(traitsPath)) {
        log.error(
          "No native character set. Use `assistant avatar character update` first.",
        );
        process.exitCode = 1;
        return;
      }

      let traits: CharacterTraits;
      try {
        const raw = readFileSync(traitsPath, "utf-8");
        traits = JSON.parse(raw) as CharacterTraits;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Failed to read character traits: ${message}`);
        process.exitCode = 1;
        return;
      }

      if (!/^\d+$/.test(opts.width)) {
        log.error(
          `Invalid width: "${opts.width}". Must be a positive integer.`,
        );
        process.exitCode = 1;
        return;
      }

      const width = parseInt(opts.width, 10);
      if (width < 1) {
        log.error(
          `Invalid width: "${opts.width}". Must be a positive integer.`,
        );
        process.exitCode = 1;
        return;
      }

      const asciiArt = renderCharacterAscii(
        traits.bodyShape,
        traits.eyeStyle,
        traits.color,
        width,
      );

      process.stdout.write(asciiArt + "\n");
    });
}
