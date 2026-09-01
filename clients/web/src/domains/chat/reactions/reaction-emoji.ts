import { EMOJI_RENDER_MAP } from "./emoji-render-map";

/**
 * A custom emoji as the channel spells it: Discord forwards
 * `<:name:id>` (or `<a:name:id>` when animated), which is the form the
 * gateway's normalizer deliberately preserves.
 */
const CUSTOM_EMOJI_MENTION = /^<(a?):([^:]+):(\d+)>$/;
/** A bare shortcode, the form Slack sends (`tada`, `+1`). */
const SHORTCODE = /^[\w+'-]+$/;

/**
 * How a reaction's stored emoji is displayed, everywhere it is displayed.
 *
 * Every surface that renders a reaction reads it from here, because the
 * rules are not obvious and drifted once already: the channel sidecar
 * rendered the raw stored value and so showed `tada` forever, while the
 * transcript resolved it. One owner, so a new surface cannot quietly get
 * this wrong.
 *
 * The rules:
 *
 * - A Discord custom emoji renders as its bare `:name:` and is NEVER looked
 *   up. A guild's custom names live in the same string space as standard
 *   shortcodes, so resolving `<:heart:123>` through the catalog would swap
 *   a guild's own emoji for an unrelated standard one.
 * - A standard shortcode resolves through the eagerly-shipped render map,
 *   falling back to `:name:` when nothing matches, which is the honest
 *   answer for a name this build does not know (a Slack workspace's custom
 *   emoji, most often).
 * - Anything else is already a glyph and passes through untouched.
 *
 * Resolution is synchronous on purpose. It used to consult the composer's
 * lazily-loaded search catalog, so a transcript's reactions painted as
 * `:tada:` and swapped to glyphs once that chunk landed, and stayed as text
 * whenever it failed. Displaying a reaction is a render concern and cannot
 * wait on an asset that exists for autocomplete.
 */
export function reactionEmojiDisplay(raw: string): string {
  const custom = CUSTOM_EMOJI_MENTION.exec(raw);
  if (custom) {
    return `:${custom[2]}:`;
  }
  if (SHORTCODE.test(raw)) {
    return EMOJI_RENDER_MAP[raw] ?? `:${raw}:`;
  }
  return raw;
}

/**
 * Whether a display string is the unresolved `:name:` form rather than a
 * glyph, which is what a surface checks before deciding to render a custom
 * emoji's image instead (see the custom-emoji notes on `reactionEmojiDisplay`).
 */
export function isUnresolvedEmojiDisplay(display: string): boolean {
  return display.startsWith(":") && display.endsWith(":") && display.length > 2;
}
