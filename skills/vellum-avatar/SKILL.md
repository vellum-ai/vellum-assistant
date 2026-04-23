---
name: vellum-avatar
description: Customize the assistant's avatar - build a native character, upload an image, or generate one with AI
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎨"
  vellum:
    display-name: "Avatar"
---

You are helping the user customize their assistant's avatar. There are three ways to set an avatar: building a native character from traits, uploading a custom image, or generating one with AI. When the user says they want to change their avatar, present all three options and ask which they prefer.

## Avatar Modes

The avatar system supports two representations:

- **Native character** - Defined by `data/avatar/character-traits.json` (body shape, eye style, color). Rendered client-side as an animated character. A static PNG at `data/avatar/avatar-image.png` is auto-generated for use by other clients and the dock icon.
- **Custom image** - A static PNG at `data/avatar/avatar-image.png`. Used for uploaded or AI-generated avatars. When set via upload (`assistant avatar set`), character traits are preserved so the native character can be restored later via `assistant avatar remove`. When AI-generated (`assistant avatar generate`), character trait files are removed.

## Mode 1: Native Character Traits

The user picks a body shape, eye style, and color. Present the options conversationally - describe what each looks like so the user can choose without seeing a preview.

### Body shapes

| Value  | Description                       |
| ------ | --------------------------------- |
| blob   | Soft, amorphous rounded shape     |
| cloud  | Puffy cloud silhouette            |
| sprout | Small plant-like form with a stem |
| star   | Five-pointed star                 |
| ghost  | Classic ghost silhouette          |
| urchin | Spiky sea-urchin shape            |
| stack  | Stacked rounded rectangles        |
| flower | Flower with petals                |
| burst  | Spiky starburst                   |
| ninja  | Stealthy masked figure            |

### Eye styles

| Value     | Description                               |
| --------- | ----------------------------------------- |
| grumpy    | Furrowed, slightly annoyed look           |
| angry     | Sharp, intense expression                 |
| curious   | Wide, inquisitive eyes                    |
| goofy     | Playful, off-kilter expression            |
| surprised | Big round eyes, startled look             |
| bashful   | Shy, half-closed eyes looking to the side |
| gentle    | Soft, kind expression                     |
| quirky    | Asymmetric, offbeat look                  |
| dazed     | Unfocused, dreamy stare                   |

### Colors

| Value  | Appearance      |
| ------ | --------------- |
| green  | Leafy green     |
| orange | Warm orange     |
| pink   | Soft pink       |
| purple | Rich purple     |
| teal   | Blue-green teal |
| yellow | Bright yellow   |

### Setting traits

After the user chooses, run the following command to set the character traits. This writes `character-traits.json`, generates the static PNG, creates an ASCII representation, updates IDENTITY.md, and notifies connected clients — all in one step:

```bash
assistant avatar character update --body-shape <value> --eye-style <value> --color <value>
```

The client will detect the traits file and render the animated character.

## Mode 2: Upload a Custom Image

The user provides a file path to an image they want to use as their avatar.

Use the CLI command to set it:

```bash
assistant avatar set --image "<user-provided-path>"
```

The path can be absolute or relative to the workspace (e.g. `conversations/<id>/attachments/Dropped Image.png`).

## Mode 3: AI-Generated Image

The user describes what they want their avatar to look like. Use the `bash` tool to run the CLI command below.

**IMPORTANT: You MUST set `network_mode` to `"proxied"` on this tool call. Without it, the command cannot reach the image generation API and will fail.**

```json
{
  "command": "assistant avatar generate --description \"<user's description>\"",
  "network_mode": "proxied"
}
```

This generates an image using AI and saves it to `data/avatar/avatar-image.png`.

## Removing the Avatar

When the user wants to remove their custom avatar and go back to the default:

```bash
assistant avatar remove
```

This removes the custom image. If a native character was previously configured, it is automatically restored (the character traits are preserved).

## Viewing the Avatar

When the user asks to see their current avatar, get the path and then read it:

```bash
assistant avatar get
```

This prints the absolute path to the avatar image (regenerating from character traits if needed). Then use `file_read` on the returned path to display the image inline.

To get the avatar as base64 data instead:

```bash
assistant avatar get --format base64
```

## UX Guidelines

- When the user says they want to change or set their avatar, present all three options:
  1. **Build a character** - Pick a body shape, eye style, and color for an animated native character
  2. **Upload an image** - Use an existing image file from their computer
  3. **Generate with AI** - Describe what they want and let AI create it
- Ask which mode they prefer before proceeding.
- For native characters, walk through each trait one at a time (body shape, then eye style, then color). Describe the options conversationally so the user can choose without seeing them.
- For AI generation, ask the user to describe the avatar they want. Be encouraging - suggest they include details like style, colors, mood, or a character concept.
- After any avatar change, confirm it was applied and let the user know they can change it again anytime.
- **After any avatar change**, update the `## Avatar` section in `IDENTITY.md` with a plain-text description of the current avatar appearance. Do NOT use markdown image links — write a human-readable description instead. This ensures you remember what you look like across sessions. Example: `## Avatar\nA friendly purple cat with green eyes wearing a tiny hat`
- **When the user asks what your avatar looks like**, read the `## Avatar` section in `IDENTITY.md` for your text description.
- **When the user asks you to show or provide your avatar**, run `assistant avatar get` to get the path, then use `file_read` on that path to display the image. Only do this once.
