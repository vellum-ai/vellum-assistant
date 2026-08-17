/**
 * Shared helpers for the settings skill's tool executors.
 */

/**
 * Steer the model back to the inline voice picker.
 *
 * Both settings tools a "change my voice" request can land on (the Voice tab
 * navigation and a managed `tts_voice_id` write) end by naming the picker, so
 * the invocation itself lives here: one edit keeps both tools teaching the same
 * call. Each caller supplies its own tail, because the reason the picker is
 * better differs by the tool the model just reached for.
 */
export function voicePickerHint(tail: string): string {
  return `Next time the user wants to change or hear a voice, prefer \`ui_show { surface_type: "voice_picker", data: {} }\`, ${tail}`;
}
