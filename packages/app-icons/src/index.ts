/**
 * The icons an app can wear, shared by the assistant (which picks and stores
 * one on an app's manifest) and the web client (which draws it).
 *
 * An app's `icon` is a Lucide kebab-case name from {@link APP_ICON_NAMES}.
 * The assistant chooses it at `app_create`; the web client keeps the
 * name-to-glyph map, typed against {@link AppIconName} so a name added here
 * without a glyph there fails its typecheck. A manifest may also carry an
 * emoji in place of a name; {@link EMOJI_ICON_NAMES} maps the common ones to
 * the name each stands for, and both sides apply the map.
 */

export const APP_ICON_NAMES = [
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
] as const;

export type AppIconName = (typeof APP_ICON_NAMES)[number];

const APP_ICON_NAME_SET: ReadonlySet<string> = new Set(APP_ICON_NAMES);

export function isAppIconName(value: string): value is AppIconName {
  return APP_ICON_NAME_SET.has(value);
}

/**
 * Emoji a manifest may carry as its icon, each mapped to the registry name
 * it stands for. Keys carry no variation selector; the lookup strips it.
 */
export const EMOJI_ICON_NAMES: Readonly<Record<string, AppIconName>> = {
  "🔢": "calculator",
  "🧮": "calculator",
  "📅": "calendar",
  "🗓": "calendar",
  "✅": "list-todo",
  "☑": "list-checks",
  "⏱": "timer",
  "⏲": "timer",
  "⏰": "alarm-clock",
  "🕐": "clock",
  "🕒": "clock",
  "📝": "notebook-pen",
  "🗒": "sticky-note",
  "✏": "pencil",
  "📄": "file-text",
  "📋": "clipboard-list",
  "🔖": "bookmark",
  "📚": "book",
  "📖": "book-open",
  "📔": "notebook-pen",
  "📊": "chart-bar",
  "📈": "chart-line",
  "📉": "chart-line",
  "🥧": "chart-pie",
  "🗄": "database",
  "🎯": "target",
  "🚩": "flag",
  "🏆": "trophy",
  "🏁": "flag",
  "💰": "wallet",
  "💵": "dollar-sign",
  "💲": "dollar-sign",
  "🐷": "piggy-bank",
  "💳": "credit-card",
  "🧾": "receipt",
  "🛒": "shopping-cart",
  "🛍": "shopping-cart",
  "📦": "package",
  "🎁": "gift",
  "🎟": "ticket",
  "🎫": "ticket",
  "✉": "mail",
  "📧": "mail",
  "📨": "mail",
  "📥": "inbox",
  "💬": "message-square",
  "🗨": "message-square",
  "📞": "phone",
  "☎": "phone",
  "🔔": "bell",
  "👥": "users",
  "👤": "contact",
  "🎵": "music",
  "🎶": "music",
  "🎧": "headphones",
  "🎤": "mic",
  "🎙": "mic",
  "📹": "video",
  "🎬": "film",
  "🎥": "film",
  "📺": "tv",
  "▶": "play",
  "🖼": "image",
  "📷": "camera",
  "📸": "camera",
  "🎮": "gamepad-2",
  "🕹": "gamepad-2",
  "🧩": "puzzle",
  "🎉": "party-popper",
  "🎊": "party-popper",
  "😀": "smile",
  "🙂": "smile",
  "🗺": "map",
  "📍": "map-pin",
  "🧭": "compass",
  "🌍": "globe",
  "🌎": "globe",
  "🌏": "globe",
  "✈": "plane",
  "🚗": "car",
  "🚌": "bus",
  "🚲": "bike",
  "🚢": "ship",
  "🚚": "truck",
  "🏠": "house",
  "🏡": "house",
  "🛏": "bed",
  "💼": "briefcase",
  "🎓": "graduation-cap",
  "🌐": "languages",
  "🧠": "brain",
  "💡": "lightbulb",
  "❤": "heart",
  "💗": "heart-pulse",
  "🏋": "dumbbell",
  "💪": "dumbbell",
  "💊": "pill",
  "🩺": "stethoscope",
  "👶": "baby",
  "🐾": "paw-print",
  "🐶": "paw-print",
  "🐱": "paw-print",
  "🍽": "utensils",
  "🍴": "utensils",
  "☕": "coffee",
  "🍷": "wine",
  "🍺": "beer",
  "🍰": "cake",
  "🎂": "cake",
  "🍎": "apple",
  "🥕": "carrot",
  "🥗": "salad",
  "🥚": "egg",
  "🐟": "fish",
  "☁": "cloud",
  "🌤": "cloud",
  "☀": "sun",
  "🌞": "sun",
  "🌙": "moon",
  "☂": "umbrella",
  "🌧": "umbrella",
  "❄": "snowflake",
  "🌡": "thermometer",
  "💧": "droplets",
  "🔥": "flame",
  "🌱": "leaf",
  "🍃": "leaf",
  "🏔": "mountain",
  "⛰": "mountain",
  "💻": "code",
  "👨‍💻": "code",
  "🖥": "terminal",
  "⌨": "terminal",
  "🤖": "bot",
  "📡": "wifi",
  "🔒": "lock",
  "🔐": "lock",
  "🔑": "key",
  "🛡": "shield",
  "⚙": "settings",
  "🔧": "wrench",
  "🛠": "wrench",
  "🔌": "plug",
  "🔋": "battery",
  "🔍": "search",
  "🔎": "search",
  "🔗": "link",
  "#️⃣": "hash",
  "📁": "folder-open",
  "📂": "folder-open",
  "🎨": "palette",
  "🖌": "pen-tool",
  "📏": "ruler",
  "⚖": "scale",
  "✂": "scissors",
  "👕": "shirt",
  "📰": "newspaper",
  "🔁": "repeat",
  "🔀": "shuffle",
  "🔊": "volume-2",
  "⭐": "star",
  "🌟": "star",
  "✨": "sparkles",
  "⚡": "zap",
  "🚀": "rocket",
};

const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/gu;

/* A value that is nothing but emoji: pictographs, emoji-presentation
   characters, skin-tone modifiers, the joiner that composes a sequence, the
   variation selectors, and keycap sequences (a digit, `#` or `*` with the
   keycap mark). Anchored, so text with an emoji in it is not an emoji. */
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\u200D|\uFE0E|\uFE0F|[0-9#*]\uFE0F?\u20E3)+$/u;
/* At least one glyph-bearing character, so a bare joiner or selector is not
   an emoji either. */
const EMOJI_GLYPH = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\u20E3/u;

/** True when `value` is an emoji (or emoji sequence) and nothing else. */
export function isEmojiAppIcon(value: string): boolean {
  return EMOJI_ONLY.test(value) && EMOJI_GLYPH.test(value);
}

/**
 * A stored icon as a client should read it: an emoji the map knows becomes
 * its registry name, and anything else passes through untouched, so reading
 * a manifest never loses an icon the map cannot place.
 */
export function bridgeEmojiAppIcon(
  icon: string | undefined,
): string | undefined {
  if (!icon) {
    return icon;
  }
  const key = icon.trim().replace(VARIATION_SELECTORS, "");
  /* An own-property check: a bare index would find `constructor` and its
     kin on the object's prototype. */
  return Object.hasOwn(EMOJI_ICON_NAMES, key) ? EMOJI_ICON_NAMES[key] : icon;
}

/**
 * The icon to persist on an app's manifest for a value the model passed: a
 * registry name (any case) as its kebab-case key, an emoji as the name it
 * maps to (or as itself when the map has none), and `undefined` for anything
 * else. URLs and text around an emoji are dropped: they would render as raw
 * strings, and an image icon is `app_generate_icon`'s job.
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
  if (isAppIconName(name)) {
    return name;
  }
  if (isEmojiAppIcon(trimmed)) {
    return bridgeEmojiAppIcon(trimmed);
  }
  return undefined;
}
