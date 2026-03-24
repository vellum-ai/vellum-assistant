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

**All commands in this skill use the `bash` tool.** `$VELLUM_DATA_DIR` and `$INTERNAL_GATEWAY_BASE_URL` are available in the sandbox environment — do not use `host_bash`.

## Avatar Modes

The avatar system supports two representations:

- **Native character** - Defined by `data/avatar/character-traits.json` (body shape, eye style, color). Rendered client-side as an animated character. A static PNG at `data/avatar/avatar-image.png` is auto-generated for use by other clients and the dock icon.
- **Custom image** - A static PNG at `data/avatar/avatar-image.png`. Used for uploaded or AI-generated avatars. No traits file exists.

See [Mutual Exclusivity Rule](#mutual-exclusivity-rule) for how these modes interact.

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

After the user chooses, run the following command to set the character traits. This writes `character-traits.json`, generates the static PNG, and creates an ASCII representation in one step:

```bash
assistant avatar character update --body-shape <value> --eye-style <value> --color <value>
```

The client will detect the traits file and render the animated character. The assistant also generates a static PNG for use as dock icon and by other clients.

## Mode 2: Upload a Custom Image

The user provides a file path to an image they want to use as their avatar.

Copy the image to the avatar location:

```bash
mkdir -p "$VELLUM_DATA_DIR/avatar"
cp "<user-provided-path>" "$VELLUM_DATA_DIR/avatar/avatar-image.png"
```

Then remove the native character files, since a custom image overrides the native character:

```bash
rm -f "$VELLUM_DATA_DIR/avatar/character-traits.json"
rm -f "$VELLUM_DATA_DIR/avatar/character-ascii.txt"
```

Tell the user their avatar has been updated. The client will pick up the new image automatically.

## Mode 3: AI-Generated Image

The user describes what they want their avatar to look like. Use the `bash` tool to run the CLI command below.

**IMPORTANT: You MUST set `network_mode` to `"proxied"` on this tool call. Without it, the command cannot reach the image generation API and will fail.**

```json
{
  "command": "assistant avatar generate --description \"<user's description>\"",
  "network_mode": "proxied"
}
```

This generates an image using AI, saves it to `data/avatar/avatar-image.png`, and removes any native character files automatically. The generated avatar will appear automatically in the client.

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
- **When the user asks what your avatar looks like**, read the `## Avatar` section in `IDENTITY.md` for your text description. If you need to see the actual image, read the file at `data/avatar/avatar-image.png` using the `file_read` tool.
- **When the user asks you to show or provide your avatar**, read and return the image file at `data/avatar/avatar-image.png` using the `file_read` tool.

## Mutual Exclusivity Rule

`character-traits.json` and `avatar-image.png` represent different avatar modes:

- **Native character** - `character-traits.json` is the source of truth. The assistant auto-generates `avatar-image.png` as a static representation, so both files coexist.
- **Custom image** - `avatar-image.png` is user-provided (uploaded or AI-generated). No traits file exists.

The client checks for character traits first - if `character-traits.json` exists, it renders the animated character. Otherwise, it falls back to `avatar-image.png` for custom images.

Enforcement rules:

- **Setting native character traits** → run `assistant avatar character update --body-shape X --eye-style Y --color Z`. This writes `character-traits.json`, auto-generates the PNG, and creates ASCII art in one step.
- **Uploading or generating a custom image** → write `avatar-image.png` and remove `character-traits.json` and `character-ascii.txt`.
