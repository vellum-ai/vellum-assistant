---
name: image-studio
description: Create images from a text description, or edit photos and graphics the user provides (remove backgrounds or watermarks, retouch, restyle, in-paint). Can produce multiple variants when the user wants options to choose from.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎨"
  vellum:
    display-name: "Image Studio"
    category: "content"
    activation-hints:
      - "User asks to generate, draw, or create an image from a text prompt"
      - "User wants to edit an existing image: background removal, watermark removal, in-painting, style change, retouching"
      - "User wants multiple variations of a visual (logo concepts, mood boards, illustration options)"
---

Use the `media_generate_image` tool via `skill_execute` to create or edit images.

## Modes

- **generate** (default): Create a new image from a text prompt.
- **edit**: Modify an existing image. Requires one or more source images via `source_paths`.

## Models

Do not pass the `model` parameter unless you need a specific tier. Omitting it uses the configured default, which is correct for most requests.

When you do need to choose, use an alias, not a concrete model ID. Aliases always resolve to the current model for that tier:

- `fast`: quickest, good quality (default tier)
- `quality`: higher fidelity, slower
- `openai`: OpenAI's model; most permissive on photo edits

Pass a concrete model ID only if the user names one explicitly. If the tool rejects an unknown model ID, the error lists the currently available models and aliases.

## Example calls

Generate (no model parameter, default is correct):

```json
{ "tool": "media_generate_image", "input": { "prompt": "A sunset over the ocean, golden hour, soft haze, 35mm photo style", "variants": 2 } }
```

Edit:

```json
{ "tool": "media_generate_image", "input": { "prompt": "Remove the watermark text from the background. Keep the subject, framing, lighting, and colors exactly identical. Change nothing else.", "mode": "edit", "source_paths": ["conversations/<conv-id>/attachments/photo.jpeg"], "model": "openai" } }
```

`source_paths` is a flat array of file path strings. Do NOT pass objects:

- Wrong: `"source_paths": [{ "path": "img.jpeg" }]` → schema validation error
- Right: `"source_paths": ["img.jpeg"]`

## Source images for edit mode

- Paths resolve inside the workspace. Conversation attachments live under `conversations/<conversation-id>/attachments/`; prefer that path for images the user attached.
- Host paths (e.g. `~/Desktop/photo.jpg`) only work if the file arrived as an attachment; the tool falls back to the stored workspace copy. If the user references a host file that was never attached, pull it into the workspace first, then pass the workspace path.

## Prompting

- Generate: describe style, composition, lighting, and mood, not just the subject.
- Edit: name the change AND what must stay the same. Models re-render the whole image, so without preservation language ("keep subject, framing, and lighting identical; only change X") they drift on crop and color.
- Aspect ratio and size have no parameter today. State them in the prompt ("16:9 widescreen banner") and verify the output.
- Use `variants` (1 to 4) when the user wants options. In **edit mode always use `variants: 1`**: edits run 60-90 seconds per variant, and two variants can exceed the tool execution timeout (`timeouts.toolExecutionTimeoutSec`, default 120s). If the user wants multiple edit options, make separate sequential calls.

## Timing

Edits on large photos are slow (1 to 2 minutes). If the tool reports a timeout ("timed out after Ns"), the result is lost; do not wait for it to appear. Retry with `variants: 1`, or if it already was 1, fall back to the CLI which writes files to disk: `assistant image-generation generate --prompt "..." --mode edit --source <path> --model openai --output-dir <dir>`.

## Output handling

Images return as inline content blocks in the tool result; they are not written to disk automatically.

- If the user just wants to see the image, the inline result is enough.
- If the user wants a file or you need to iterate on the result, save it to disk and deliver it through the conversation's attachment mechanism.

## Error handling

Two kinds of failure. Treat them differently:

1. **Configuration errors** (missing API key, provider not set up): report the error to the user as-is. Do NOT change service configuration (managed vs your-own mode, default provider, or default model in Settings). Configuration changes happen only at the user's explicit request.
2. **Generation failures** (any other error: "invalid", content policy, safety rejection, provider error). Do not diagnose the cause; switch providers. The error message names the model that failed:
   - If the error names a `gemini-*` model (or no model) → retry ONCE with `model: "openai"`.
   - If the error names `gpt-image-2` or another `gpt-*` model → retry ONCE with `model: "quality"`.
   - If the retry also fails → stop and report both errors to the user.

Do NOT rephrase the prompt and retry on the same model, even if the error suggests checking the prompt. One provider switch, then stop.

## Complete when

The tool has returned at least one image and the user can see it: either the inline result in chat or an attached saved file. An error report counts as complete only after the retry path in Error handling has been exhausted.
