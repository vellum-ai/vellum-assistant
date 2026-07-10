/**
 * Declarative help for the `assistant avatar` command.
 *
 * Plain data (no action handlers, imports only the help contract type) so the
 * memory capability indexer can read it without pulling in the daemon/IPC action
 * graph. The handlers live in `avatar.ts`, which applies this via
 * `applyCommandHelp` and attaches them.
 */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const avatarHelp: CliCommandHelp = {
  name: "avatar",
  description: "Manage the assistant's avatar",
  helpText: `
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
  subcommands: [
    {
      name: "generate",
      description: "Generate an AI avatar from a text description",
      options: [
        {
          flags: "--description <text>",
          description: "Description of the avatar to generate",
          required: true,
        },
      ],
      helpText: `
Generates an avatar image using AI based on the provided text description
and saves it as the assistant's avatar PNG. This replaces any existing
native character avatar — the character traits and ASCII files are removed.

On success, writes avatar-image.png to $VELLUM_WORKSPACE_DIR/data/avatar/
and removes character-traits.json and character-ascii.txt if they exist.

Examples:
  $ assistant avatar generate --description "a cute blue cat"
  $ assistant avatar generate --description "a friendly robot with green eyes"`,
    },
    {
      name: "set",
      description:
        "Set the assistant's avatar from an image file (removes any native character)",
      options: [
        {
          flags: "--image <path>",
          description: "Path to image file (absolute or relative to workspace)",
          required: true,
        },
      ],
      helpText: `
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
    },
    {
      name: "remove",
      description: "Reset the avatar to none (clears image and character)",
      helpText: `
Resets the avatar to its empty state. This deletes ALL avatar artifacts —
the custom image (avatar-image.png) AND any configured native character
(character-traits.json / character-ascii.txt) — and marks the avatar as
"none".

This is destructive: a previously configured native character is NOT
preserved and will not be restored. Rebuild the character (or set a new
image) to configure an avatar again.

Examples:
  $ assistant avatar remove`,
    },
    {
      name: "get",
      description: "Retrieve the current avatar",
      options: [
        {
          flags: "--format <format>",
          description: "Output format: path or base64",
          defaultValue: "path",
        },
      ],
      helpText: `
Retrieves the current avatar. By default prints the absolute file path;
with --format base64, prints the base64-encoded image content.

If no avatar image exists but character-traits.json is present, the PNG
is regenerated from the saved traits before output.

Examples:
  $ assistant avatar get
  $ assistant avatar get --format path
  $ assistant avatar get --format base64`,
    },
    {
      name: "character",
      description: "Manage the native character avatar",
      helpText: `
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
      subcommands: [
        {
          name: "update",
          description: "Set character traits and regenerate avatar",
          options: [
            {
              flags: "--body-shape <shape>",
              description: "Body shape (e.g. blob, cloud, star)",
              required: true,
            },
            {
              flags: "--eye-style <style>",
              description: "Eye style (e.g. curious, gentle, goofy)",
              required: true,
            },
            {
              flags: "--color <color>",
              description: "Body color (e.g. green, purple, teal)",
              required: true,
            },
          ],
          helpText: `
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
        },
        {
          name: "components",
          description: "List available character traits",
          options: [
            { flags: "--json", description: "Machine-readable JSON output" },
          ],
          helpText: `
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
        },
        {
          name: "ascii",
          description: "Print the current character as ASCII art",
          options: [
            {
              flags: "--width <n>",
              description: "Output width in characters",
              defaultValue: "60",
            },
          ],
          helpText: `
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
        },
      ],
    },
  ],
};
