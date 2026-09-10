/**
 * The icons an app can wear, as the Lucide kebab-case names the web client
 * resolves to glyphs (`clients/web/src/utils/app-icon-registry.ts`). The
 * two lists are kept identical by hand: a name added here without a glyph
 * there renders as the client's default, and a glyph there the model cannot
 * name here is never chosen.
 *
 * The assistant picks one at `app_create` (`preview.icon`), the way a user
 * picks a folder icon for a sidebar group, so every app in the sidebar and
 * the library wears a glyph from the product's own icon set rather than an
 * emoji drawn by whichever platform is rendering it.
 */
export const APP_ICON_NAMES: readonly string[] = [
  "calculator",
  "calendar",
  "list-todo",
  "list-checks",
  "square-check",
  "timer",
  "clock",
  "alarm-clock",
  "notebook-pen",
  "sticky-note",
  "pencil",
  "file-text",
  "clipboard-list",
  "bookmark",
  "book",
  "book-open",
  "chart-bar",
  "chart-line",
  "chart-pie",
  "table",
  "square-kanban",
  "database",
  "gauge",
  "activity",
  "target",
  "flag",
  "trophy",
  "wallet",
  "dollar-sign",
  "piggy-bank",
  "credit-card",
  "receipt",
  "percent",
  "shopping-cart",
  "package",
  "gift",
  "ticket",
  "mail",
  "inbox",
  "message-square",
  "phone",
  "bell",
  "users",
  "contact",
  "music",
  "headphones",
  "mic",
  "video",
  "film",
  "tv",
  "play",
  "image",
  "camera",
  "gamepad-2",
  "puzzle",
  "party-popper",
  "smile",
  "map",
  "map-pin",
  "compass",
  "globe",
  "plane",
  "car",
  "bus",
  "bike",
  "ship",
  "truck",
  "house",
  "bed",
  "briefcase",
  "graduation-cap",
  "languages",
  "brain",
  "lightbulb",
  "heart",
  "heart-pulse",
  "dumbbell",
  "pill",
  "stethoscope",
  "baby",
  "paw-print",
  "utensils",
  "coffee",
  "wine",
  "beer",
  "cake",
  "apple",
  "carrot",
  "salad",
  "egg",
  "fish",
  "cloud",
  "sun",
  "moon",
  "umbrella",
  "snowflake",
  "thermometer",
  "droplets",
  "flame",
  "leaf",
  "mountain",
  "code",
  "terminal",
  "cpu",
  "bot",
  "wifi",
  "lock",
  "key",
  "shield",
  "settings",
  "wrench",
  "plug",
  "battery",
  "search",
  "link",
  "hash",
  "layers",
  "folder-open",
  "palette",
  "pen-tool",
  "ruler",
  "scale",
  "scissors",
  "shirt",
  "newspaper",
  "repeat",
  "shuffle",
  "volume-2",
  "speaker",
  "star",
  "sparkles",
  "zap",
  "rocket",
  "home",
];

const APP_ICON_NAME_SET = new Set(APP_ICON_NAMES);

/* Pictographs, emoji-presentation characters, and the variation selector /
   keycap marks that turn a digit into an emoji. Apps built before the icon
   registry carry one of these, and a model that still reaches for one gets
   it kept rather than dropped. */
const EMOJI_PATTERN =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u20E3/u;

/** An emoji, at most a short grapheme cluster or two, and nothing else. */
const EMOJI_MAX_LENGTH = 16;

/**
 * The icon to persist on an app's manifest for what the model passed: a
 * registry name (any case) normalised to its kebab-case key, an emoji kept
 * as is, and `undefined` for anything else. URLs in particular are dropped:
 * they would render as raw strings in the UI and in bundle manifests, and an
 * image icon is `app_generate_icon`'s job.
 */
export function normalizeAppIcon(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || /^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  const name = trimmed.toLowerCase();
  if (APP_ICON_NAME_SET.has(name)) {
    return name;
  }
  if (trimmed.length <= EMOJI_MAX_LENGTH && EMOJI_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}
