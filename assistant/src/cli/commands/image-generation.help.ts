/** Declarative help for the `assistant image-generation` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const imageGenerationHelp: CliCommandHelp = {
  name: "image-generation",
  description: "AI image generation and editing",
  helpText: `
Modes:
  managed    — Uses platform-managed credentials (requires login to Vellum).
  your-own   — Uses your own Gemini or OpenAI API key depending on the configured model.

Supported models: pass a tier alias, the assistant resolves it to the
current model for that tier.
  fast     (default) quickest, good quality
  quality  higher fidelity, slower
  openai   OpenAI's model
A concrete model ID is also accepted; unknown values return an error
listing the currently available models.

Examples:
  $ assistant image-generation generate --prompt "A sunset over the ocean"
  $ assistant image-generation generate --prompt "Remove background" --mode edit --source photo.png
  $ assistant image-generation generate --prompt "Logo design" --variants 3 --output-dir ./output
  $ assistant image-generation generate --prompt "A cat" --json`,
  subcommands: [
    {
      name: "generate",
      description: "Generate or edit images using AI",
      options: [
        {
          flags: "--prompt <text>",
          description: "Description of the image to generate or edits to apply",
          required: true,
        },
        {
          flags: "--mode <mode>",
          description: "generate (default) or edit",
          defaultValue: "generate",
        },
        {
          flags: "--source <path...>",
          description: "Source image file path for edit mode (repeatable)",
        },
        { flags: "--model <model-id>", description: "Model override" },
        {
          flags: "--variants <n>",
          description: "Number of variants (1-4, default 1)",
          defaultValue: 1,
        },
        {
          flags: "--output-dir <dir>",
          description: "Directory to save images",
        },
        { flags: "--json", description: "Output structured JSON" },
      ],
      helpText: `
Notes:
  Edit mode (--mode edit) requires at least one --source image file.
  Output files are named image-1.png, image-2.png, etc. (extension matches MIME type).
  Default output directory is the system temp directory.
  Uses your own Gemini or OpenAI API key depending on the configured model.

Examples:
  $ assistant image-generation generate --prompt "A mountain landscape at dawn"
  $ assistant image-generation generate --prompt "Make it darker" --mode edit --source input.png
  $ assistant image-generation generate --prompt "Logo variations" --variants 4 --output-dir ./logos
  $ assistant image-generation generate --prompt "A robot" --model quality --json
  $ assistant image-generation generate --prompt "A robot" --model openai --json`,
    },
  ],
};
