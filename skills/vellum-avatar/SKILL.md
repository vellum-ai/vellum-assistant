---
name: vellum-avatar
description: Customize the assistant's avatar — build a native character, upload an image, or generate one with AI
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎨"
  vellum:
    display-name: "Avatar"
    user-invocable: true
---

You are helping the user customize their assistant's avatar. There are three ways to set an avatar: building a native character from traits, uploading a custom image, or generating one with AI. When the user says they want to change their avatar, present all three options and ask which they prefer.

## Avatar Modes

The avatar system supports two mutually exclusive representations:

- **Native character** — Defined by `data/avatar/character-traits.json` (body shape, eye style, color). Rendered client-side as an animated character.
- **Custom image** — A static PNG at `data/avatar/avatar-image.png`. Used for uploaded or AI-generated avatars.

These are mutually exclusive. Setting a native character must remove the custom image file, and setting a custom image (via upload or AI generation) must remove the character traits file. This ensures the client always knows which representation to display.

## Mode 1: Native Character Traits

The user picks a body shape, eye style, and color. Present the options conversationally — describe what each looks like so the user can choose without seeing a preview.

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

After the user chooses, write the selection to `data/avatar/character-traits.json` (relative to the workspace root):

```json
{
  "bodyShape": "<chosen-body-shape>",
  "eyeStyle": "<chosen-eye-style>",
  "color": "<chosen-color>"
}
```

```bash
mkdir -p "$(assistant workspace-dir)/data/avatar"
cat > "$(assistant workspace-dir)/data/avatar/character-traits.json" << 'TRAITS'
{ "bodyShape": "<value>", "eyeStyle": "<value>", "color": "<value>" }
TRAITS
```

Then remove the custom image file if it exists, since native character mode takes precedence:

```bash
rm -f "$(assistant workspace-dir)/data/avatar/avatar-image.png"
```

The client will detect the traits file and render the animated character.

## Mode 2: Upload a Custom Image

The user provides a file path to an image they want to use as their avatar.

Copy the image to the avatar location:

```bash
mkdir -p "$(assistant workspace-dir)/data/avatar"
cp "<user-provided-path>" "$(assistant workspace-dir)/data/avatar/avatar-image.png"
```

Then remove the character traits file, since a custom image overrides the native character:

```bash
rm -f "$(assistant workspace-dir)/data/avatar/character-traits.json"
```

Tell the user their avatar has been updated. The client will pick up the new image automatically.

## Mode 3: AI-Generated Image

The user describes what they want their avatar to look like. Use `bash` to call the daemon's avatar generation HTTP endpoint:

```bash
curl -s -X POST http://localhost:${VELLUM_DAEMON_PORT:-9320}/v1/settings/avatar/generate \
  -H "Content-Type: application/json" \
  -d '{"description": "<user'\''s description>"}'
```

This generates an image using AI and saves it to `data/avatar/avatar-image.png`. After the image is generated, remove the character traits file:

```bash
rm -f "$(assistant workspace-dir)/data/avatar/character-traits.json"
```

The generated avatar will appear automatically in the client.

## UX Guidelines

- When the user says they want to change or set their avatar, present all three options:
  1. **Build a character** — Pick a body shape, eye style, and color for an animated native character
  2. **Upload an image** — Use an existing image file from their computer
  3. **Generate with AI** — Describe what they want and let AI create it
- Ask which mode they prefer before proceeding.
- For native characters, walk through each trait one at a time (body shape, then eye style, then color). Describe the options conversationally so the user can choose without seeing them.
- For AI generation, ask the user to describe the avatar they want. Be encouraging — suggest they include details like style, colors, mood, or a character concept.
- After any avatar change, confirm it was applied and let the user know they can change it again anytime.

## Mutual Exclusivity Rule

`character-traits.json` and `avatar-image.png` represent different avatar modes. The client checks for a custom image first — if `avatar-image.png` exists, it displays that. Otherwise, it reads `character-traits.json` to render the native animated character.

Always enforce this rule:

- **Setting native character traits** → remove `avatar-image.png`
- **Uploading or generating a custom image** → remove `character-traits.json`

This prevents stale data from one mode leaking into the other.
