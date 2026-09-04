/**
 * The voice room's shared layout vocabulary: the device insets every surface
 * in it clears, the vertical zones its text sits in, and the corner offsets
 * and camera band its chrome hangs off.
 *
 * One home for these because two implementations draw the room: `voice-room.tsx`
 * over a live session, and the Storybook scenes that stand the same chrome up
 * over a still frame. An offset written twice is an offset that drifts the
 * first time one of them is retuned, and the story is where the layout is
 * reviewed.
 *
 * ## Vertical zones for the room's text surfaces
 *
 * The room reads top-to-bottom as the conversation itself: the user's
 * transcribed speech in the upper zone, the character's eyes holding the
 * center, and the assistant's speech — or, when live captions are off, the
 * state caption naming the beat — in the lower zone.
 *
 * Every text surface in the room anchors to these constants, so the model holds
 * across both looks: the transcript's two halves, the state caption, and the
 * thinking triad all derive their vertical position from one place.
 *
 * Zones are inset past the room's corner controls — the gear/✕ cluster above,
 * the mute/stop cluster below — so text never collides with them. The `rem`
 * floor in each anchor is what guarantees that clearance: the controls are a
 * fixed 3.25rem tall at a 1.25rem inset, which reaches 4.5rem, so the floor
 * sits a quarter of a rem past that rather than tangent to it. The percentage
 * takes over on taller viewports, where hugging a fixed offset off the edge
 * would strand the text far below the eyes. Both are safe-area aware per
 * docs/CAPACITOR.md: the `var()` is set by `capacitor-plugin-safe-area` on
 * Capacitor iOS, `env()` covers standard browsers with `viewport-fit=cover`,
 * and `0px` covers desktop / non-notch devices.
 *
 * Percentages (not `vh`) resolve against the room box, so the zones size
 * correctly both in the app — where the room is a `fixed inset-0` overlay — and
 * in the Storybook harnesses, which render the room inside a bounded frame.
 */

export const SAFE_AREA_TOP =
  "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))";
export const SAFE_AREA_BOTTOM =
  "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))";
export const SAFE_AREA_LEFT =
  "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))";
export const SAFE_AREA_RIGHT =
  "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))";

/** Top edge of the upper (user) zone — clears the top-right gear/✕ cluster. */
export const VOICE_ROOM_UPPER_ZONE_TOP = `calc(max(4.75rem, 11%) + ${SAFE_AREA_TOP})`;
/** Height of the upper zone. Content is bottom-anchored inside it, so a longer
 *  utterance grows upward and its oldest lines dissolve into the fade. */
export const VOICE_ROOM_UPPER_ZONE_HEIGHT = "18%";

/**
 * Bottom edge of the lower (assistant) zone — clears the mute/stop cluster.
 * The state caption and the assistant transcript's last line share this
 * baseline, so turning live captions on replaces the status word roughly in
 * place rather than moving the room's text to a different region.
 */
export const VOICE_ROOM_LOWER_ZONE_BOTTOM = `calc(max(4.75rem, 14%) + ${SAFE_AREA_BOTTOM})`;
/** Ceiling on the lower zone. Content is bottom-anchored, so a long response
 *  keeps its newest words on the baseline and fades out the top. */
export const VOICE_ROOM_LOWER_ZONE_MAX_HEIGHT = "28%";

/**
 * The room's single text measure. Both zones center a column of this width and
 * left-align their text inside it, which is what keeps the word-by-word reveal
 * stable: centered text re-centers its last line on every arriving word, so the
 * words already on screen would shimmy sideways as speech streams in. One
 * shared left edge also gives the two speakers a common spine — they're told
 * apart by zone, type scale, and treatment, not by alignment.
 */
export const VOICE_ROOM_TEXT_MEASURE = "min(36rem, 82vw)";

/**
 * Top-to-bottom dissolve for both zones: with content bottom-anchored, the
 * oldest lines fade out as newer ones push up past the zone's ceiling.
 */
export const VOICE_ROOM_ZONE_FADE =
  "linear-gradient(to bottom, transparent, #000 15%)";

/**
 * Type size for the room's status voice — the state caption, and anything that
 * should read as its peer. The thinking triad sizes its dots in `em` against
 * this, so the dots stay a fixed fraction of the caption beside them at every
 * viewport rather than drifting heavier or lighter than the words.
 */
export const VOICE_ROOM_CAPTION_TEXT = "clamp(15px, 2.2vmin, 22px)";

/**
 * Gap between a corner control and the room's edges. One constant so the
 * top-right exit, the camera's top-left view options and the bottom control
 * row sit on the same rhythm.
 */
export const VOICE_ROOM_CORNER_GAP = "1.25rem";

/**
 * Where a corner box hangs off its own edge: the room's gap, or the device's
 * inset on that side where that is deeper. Per side, because a control belongs
 * to the corner it sits in and a cutout is not symmetric.
 */
export const VOICE_ROOM_CORNER_LEFT = `max(${VOICE_ROOM_CORNER_GAP}, ${SAFE_AREA_LEFT})`;
export const VOICE_ROOM_CORNER_RIGHT = `max(${VOICE_ROOM_CORNER_GAP}, ${SAFE_AREA_RIGHT})`;

/**
 * The band the camera status pill is centred in, on the same line as the
 * room's corner chrome. A configured assistant name is arbitrarily long, so
 * without a bound the pill runs under that chrome and off a phone-width room.
 *
 * ONE reserve, taken off both edges: the deepest of the room's corner offset
 * and the two safe-area insets, plus the 3.25rem control a corner holds, plus
 * the 0.5rem gap the pill and that control never close. Each corner holds a
 * single control, so one control's width covers both, and one value covers
 * both sides because a display cutout is not symmetric: a reserve computed per
 * side would differ by the difference between the insets and carry the pill
 * half that far off the room's centre line, which is the line the eye reads it
 * against. The corner controls still hug their own side's inset, so the
 * shallow side gets more clearance than it strictly needs.
 *
 * The pill's floor survives both ends of that. A 320pt portrait room has no
 * side insets to deepen the reserve, and the landscape rooms where the insets
 * do get deep are hundreds of points wider than they are tall. Either way the
 * band stays wider than the pill's own floor, so a long name truncates inside
 * the ceiling the band gives it rather than overhanging a corner.
 */
export const CAMERA_PILL_INSET = `calc(max(${VOICE_ROOM_CORNER_GAP}, ${SAFE_AREA_LEFT}, ${SAFE_AREA_RIGHT}) + 3.75rem)`;
