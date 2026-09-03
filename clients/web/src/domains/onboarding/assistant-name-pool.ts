/**
 * Locale-aware assistant name pools for the onboarding name step.
 *
 * Region is resolved from the host language list plus IANA timezone. When
 * those two signals name different regions, timezone wins: it is where the
 * person lives, while the browser language often just reflects what they
 * installed.
 *
 * Each region keeps the four personality groups (grounded, warm, energetic,
 * poetic) so a group picker still has a complete set. Unknown regions fall
 * back to the English pool.
 */

import { getBrowserTimezone } from "@/utils/browser-timezone";
import { systemLocales } from "@/i18n/system-locale";

export const PERSONALITY_GROUP_IDS = [
  "grounded",
  "warm",
  "energetic",
  "poetic",
] as const;

export type PersonalityGroupId = (typeof PERSONALITY_GROUP_IDS)[number];

export const NAMING_REGIONS = [
  "en",
  "nl",
  "pt",
  "es",
  "de",
  "fr",
  "ko",
  "ja",
  "zh",
  "zh-TW",
  "ru",
] as const;

export type NamingRegion = (typeof NAMING_REGIONS)[number];

export type NamingSignal = "timezone" | "locale" | "agree" | "fallback";

export type NamingSource = "surprise_me" | "custom";

export interface NamingSignals {
  locales: readonly string[];
  timezone: string;
}

export interface NamingResolution {
  region: NamingRegion;
  signal: NamingSignal;
  localeRegion: NamingRegion | null;
  timezoneRegion: NamingRegion | null;
}

export interface AssistantNamingChoice {
  source: NamingSource;
  region: NamingRegion;
  signal: NamingSignal;
}

export interface ResolvedAssistantNamePool {
  region: NamingRegion;
  signal: NamingSignal;
  localeRegion: NamingRegion | null;
  timezoneRegion: NamingRegion | null;
  groups: Record<PersonalityGroupId, readonly string[]>;
  names: readonly string[];
}

export const DEFAULT_NAMING_REGION: NamingRegion = "en";

const SUGGESTION_COUNT = 6;

type LocaleNamePool = Record<PersonalityGroupId, readonly string[]>;

/**
 * Curated given names people in each region actually use. Six per personality
 * group, unique within the locale. Checked for anything unfortunate before
 * being listed.
 */
const NAME_POOLS: Record<NamingRegion, LocaleNamePool> = {
  en: {
    grounded: ["Penn", "Sage", "Atlas", "Orion", "Reed", "Quill"],
    warm: ["Kit", "Remy", "Wren", "Milo", "Fenn", "Cleo"],
    energetic: ["Nova", "Ember", "Cade", "Lark", "Vela", "Ziggy"],
    poetic: ["Luna", "Iris", "Vesper", "Lyra", "Juno", "Ada"],
  },
  nl: {
    grounded: ["Bram", "Sander", "Teun", "Noud", "Cas", "Joost"],
    warm: ["Fleur", "Sem", "Noor", "Daan", "Saar", "Liv"],
    energetic: ["Finn", "Dex", "Jip", "Bo", "Kai", "Jet"],
    poetic: ["Fenna", "Isa", "Elin", "Mila", "Nora", "Puck"],
  },
  pt: {
    grounded: ["Caio", "Hugo", "Rafael", "Tomás", "Heitor", "Bruno"],
    warm: ["Sofia", "Clara", "Lia", "Miguel", "Ana", "Pedro"],
    energetic: ["Nico", "Luca", "Theo", "Bia", "Gaia", "Rico"],
    poetic: ["Luna", "Isla", "Maya", "Aurora", "Vera", "Inês"],
  },
  es: {
    grounded: ["Mateo", "Diego", "Pablo", "Andrés", "Marcos", "Hugo"],
    warm: ["Sofía", "Camila", "Lucía", "Elena", "Nico", "Clara"],
    energetic: ["Gael", "Ciro", "Axel", "Vera", "Valentina", "Iker"],
    poetic: ["Luna", "Aura", "Iris", "Alma", "Cielo", "Nora"],
  },
  de: {
    grounded: ["Jonas", "Lukas", "Paul", "Emil", "Ben", "Karl"],
    warm: ["Mia", "Emma", "Lina", "Noah", "Lea", "Eli"],
    energetic: ["Max", "Felix", "Nico", "Mila", "Leo", "Pia"],
    poetic: ["Luna", "Ida", "Nora", "Freya", "Ella", "Liv"],
  },
  fr: {
    grounded: ["Louis", "Hugo", "Arthur", "Jules", "Adam", "Paul"],
    warm: ["Léa", "Chloé", "Rose", "Tom", "Inès", "Louise"],
    energetic: ["Léo", "Sacha", "Zoé", "Milo", "Jade", "Axel"],
    poetic: ["Luna", "Iris", "Léonie", "Ava", "Camille", "Noé"],
  },
  ko: {
    grounded: ["민준", "서준", "도윤", "하준", "주원", "시우"],
    warm: ["서연", "하윤", "지아", "수아", "지유", "채원"],
    energetic: ["지호", "예준", "시윤", "유나", "하은", "다은"],
    poetic: ["서윤", "지민", "수빈", "하린", "은서", "소율"],
  },
  ja: {
    grounded: ["湊", "蓮", "樹", "陽翔", "大和", "蒼"],
    warm: ["陽葵", "結衣", "咲良", "悠真", "結菜", "心春"],
    energetic: ["颯", "翔", "陸", "湊太", "陽太", "迅"],
    poetic: ["凛", "紬", "結月", "詩", "雪", "月"],
  },
  zh: {
    grounded: ["浩然", "志远", "子轩", "俊杰", "文博", "明哲"],
    warm: ["欣怡", "雨桐", "嘉怡", "思源", "梓萱", "一诺"],
    energetic: ["浩宇", "晨曦", "宇轩", "天翊", "启航", "泽楷"],
    poetic: ["诗涵", "语嫣", "清欢", "若汐", "晚晴", "星河"],
  },
  "zh-TW": {
    grounded: ["志明", "家豪", "承翰", "俊傑", "文博", "明哲"],
    warm: ["雅婷", "怡君", "佳穎", "淑芬", "心怡", "宜蓁"],
    energetic: ["冠宇", "柏翰", "子軒", "浩宇", "承恩", "宇翔"],
    poetic: ["詩涵", "語嫣", "清歡", "若曦", "晚晴", "星河"],
  },
  ru: {
    grounded: ["Лев", "Марк", "Тихон", "Глеб", "Роман", "Илья"],
    warm: ["Мира", "Лера", "Соня", "Даня", "Ника", "Тоня"],
    energetic: ["Захар", "Платон", "Егор", "Кира", "Яна", "Тима"],
    poetic: ["Вера", "Лада", "Ася", "Лиза", "Аля", "Нина"],
  },
};

const WEAK_TIMEZONES = new Set([
  "UTC",
  "Etc/UTC",
  "GMT",
  "Etc/GMT",
  "Etc/GMT+0",
  "Etc/GMT-0",
  "Etc/GMT0",
  "Etc/Unknown",
]);

const EXACT_TIMEZONE_REGIONS: Record<string, NamingRegion> = {
  "Europe/Amsterdam": "nl",
  "Europe/Brussels": "nl",
  "America/Aruba": "nl",
  "America/Curacao": "nl",
  "America/Kralendijk": "nl",
  "America/Lower_Princes": "nl",

  "Europe/Lisbon": "pt",
  "Atlantic/Madeira": "pt",
  "Atlantic/Azores": "pt",
  "America/Sao_Paulo": "pt",
  "America/Fortaleza": "pt",
  "America/Recife": "pt",
  "America/Bahia": "pt",
  "America/Belem": "pt",
  "America/Manaus": "pt",
  "America/Cuiaba": "pt",
  "America/Porto_Velho": "pt",
  "America/Boa_Vista": "pt",
  "America/Rio_Branco": "pt",
  "America/Campo_Grande": "pt",
  "America/Maceio": "pt",
  "America/Araguaina": "pt",
  "America/Santarem": "pt",
  "America/Noronha": "pt",
  "America/Eirunepe": "pt",

  "Europe/Madrid": "es",
  "Atlantic/Canary": "es",
  "America/Mexico_City": "es",
  "America/Cancun": "es",
  "America/Merida": "es",
  "America/Monterrey": "es",
  "America/Tijuana": "es",
  "America/Hermosillo": "es",
  "America/Chihuahua": "es",
  "America/Mazatlan": "es",
  "America/Bahia_Banderas": "es",
  "America/Bogota": "es",
  "America/Lima": "es",
  "America/Santiago": "es",
  "America/Caracas": "es",
  "America/Guayaquil": "es",
  "America/Asuncion": "es",
  "America/La_Paz": "es",
  "America/Montevideo": "es",
  "America/Guatemala": "es",
  "America/El_Salvador": "es",
  "America/Tegucigalpa": "es",
  "America/Managua": "es",
  "America/Costa_Rica": "es",
  "America/Panama": "es",
  "America/Havana": "es",
  "America/Santo_Domingo": "es",
  "America/Puerto_Rico": "es",

  "Europe/Berlin": "de",
  "Europe/Vienna": "de",
  "Europe/Zurich": "de",
  "Europe/Vaduz": "de",

  "Europe/Paris": "fr",
  "Europe/Monaco": "fr",
  "America/Martinique": "fr",
  "America/Guadeloupe": "fr",
  "America/Cayenne": "fr",
  "America/Miquelon": "fr",
  "America/Marigot": "fr",
  "America/St_Barthelemy": "fr",
  "Indian/Reunion": "fr",
  "Pacific/Noumea": "fr",
  "Pacific/Tahiti": "fr",

  "Asia/Seoul": "ko",
  "Asia/Tokyo": "ja",
  "Asia/Shanghai": "zh",
  "Asia/Chongqing": "zh",
  "Asia/Urumqi": "zh",
  "Asia/Harbin": "zh",
  "Asia/Kashgar": "zh",
  "Asia/Taipei": "zh-TW",
  "Asia/Hong_Kong": "zh-TW",
  "Asia/Macau": "zh-TW",

  "Europe/Moscow": "ru",
  "Europe/Kaliningrad": "ru",
  "Europe/Samara": "ru",
  "Europe/Volgograd": "ru",
  "Europe/Saratov": "ru",
  "Europe/Ulyanovsk": "ru",
  "Europe/Astrakhan": "ru",
  "Europe/Kirov": "ru",
  "Asia/Yekaterinburg": "ru",
  "Asia/Omsk": "ru",
  "Asia/Novosibirsk": "ru",
  "Asia/Barnaul": "ru",
  "Asia/Tomsk": "ru",
  "Asia/Novokuznetsk": "ru",
  "Asia/Krasnoyarsk": "ru",
  "Asia/Irkutsk": "ru",
  "Asia/Chita": "ru",
  "Asia/Yakutsk": "ru",
  "Asia/Vladivostok": "ru",
  "Asia/Magadan": "ru",
  "Asia/Sakhalin": "ru",
  "Asia/Kamchatka": "ru",
  "Asia/Anadyr": "ru",

  "Europe/London": "en",
  "Europe/Dublin": "en",
  "Africa/Johannesburg": "en",
  "Pacific/Auckland": "en",
  "Pacific/Honolulu": "en",
};

const TIMEZONE_PREFIX_REGIONS: ReadonlyArray<readonly [string, NamingRegion]> =
  [
    ["America/Argentina/", "es"],
    ["America/Indiana/", "en"],
    ["America/Kentucky/", "en"],
    ["America/North_Dakota/", "en"],
    ["US/", "en"],
    ["Canada/", "en"],
    ["Australia/", "en"],
    ["Pacific/Auckland", "en"],
    ["GB", "en"],
    ["NZ", "en"],
    ["ROC", "zh-TW"],
    ["PRC", "zh"],
    ["ROK", "ko"],
    ["Japan", "ja"],
    ["Brazil/", "pt"],
    ["Chile/", "es"],
    ["Mexico/", "es"],
  ];

function isNamingRegion(value: string): value is NamingRegion {
  return (NAMING_REGIONS as readonly string[]).includes(value);
}

export function namesForRegion(region: NamingRegion): LocaleNamePool {
  return NAME_POOLS[region] ?? NAME_POOLS[DEFAULT_NAMING_REGION];
}

export function allNamesForRegion(region: NamingRegion): string[] {
  const groups = namesForRegion(region);
  return PERSONALITY_GROUP_IDS.flatMap((id) => [...groups[id]]);
}

export function regionFromLocaleTag(tag: string): NamingRegion | null {
  const normalized = tag.trim().replaceAll("_", "-");
  if (!normalized) {
    return null;
  }
  const parts = normalized.split("-").filter(Boolean);
  const lang = parts[0]?.toLowerCase();
  if (!lang) {
    return null;
  }
  const rest = parts.slice(1).map((part) => part.toLowerCase());

  if (lang === "zh") {
    if (
      rest.some(
        (part) =>
          part === "tw" || part === "hk" || part === "mo" || part === "hant",
      )
    ) {
      return "zh-TW";
    }
    return "zh";
  }

  if (isNamingRegion(lang)) {
    return lang;
  }
  return null;
}

export function regionFromLocales(
  locales: readonly string[],
): NamingRegion | null {
  for (const tag of locales) {
    const region = regionFromLocaleTag(tag);
    if (region) {
      return region;
    }
  }
  return null;
}

export function regionFromTimezone(timezone: string): NamingRegion | null {
  const zone = timezone.trim();
  if (!zone || WEAK_TIMEZONES.has(zone)) {
    return null;
  }

  const exact = EXACT_TIMEZONE_REGIONS[zone];
  if (exact) {
    return exact;
  }

  for (const [prefix, region] of TIMEZONE_PREFIX_REGIONS) {
    if (zone === prefix || zone.startsWith(prefix)) {
      return region;
    }
  }

  // Unlisted America/* cities are US/Canada English. LatAm, Brazil, and
  // Caribbean zones are claimed in the exact map above.
  if (zone.startsWith("America/")) {
    if (zone.startsWith("America/Argentina/")) {
      return "es";
    }
    return "en";
  }

  return null;
}

/**
 * Pick the naming region from language + timezone. Timezone wins when the
 * two disagree.
 */
export function resolveNamingRegion(
  signals: NamingSignals,
): NamingResolution {
  const timezoneRegion = regionFromTimezone(signals.timezone);
  const localeRegion = regionFromLocales(signals.locales);

  if (timezoneRegion && localeRegion) {
    if (timezoneRegion !== localeRegion) {
      return {
        region: timezoneRegion,
        signal: "timezone",
        localeRegion,
        timezoneRegion,
      };
    }
    return {
      region: timezoneRegion,
      signal: "agree",
      localeRegion,
      timezoneRegion,
    };
  }
  if (timezoneRegion) {
    return {
      region: timezoneRegion,
      signal: "timezone",
      localeRegion,
      timezoneRegion,
    };
  }
  if (localeRegion) {
    return {
      region: localeRegion,
      signal: "locale",
      localeRegion,
      timezoneRegion,
    };
  }
  return {
    region: DEFAULT_NAMING_REGION,
    signal: "fallback",
    localeRegion,
    timezoneRegion,
  };
}

export function readHostNamingSignals(): NamingSignals {
  return {
    locales: systemLocales(),
    timezone: getBrowserTimezone(),
  };
}

export function resolveAssistantNamePool(
  signals: NamingSignals = readHostNamingSignals(),
): ResolvedAssistantNamePool {
  const resolution = resolveNamingRegion(signals);
  const groups = namesForRegion(resolution.region);
  return {
    ...resolution,
    groups,
    names: allNamesForRegion(resolution.region),
  };
}

export function pickNameFromPool(
  names: readonly string[],
  options: { exclude?: string; random?: () => number } = {},
): string {
  const random = options.random ?? Math.random;
  const candidates = options.exclude
    ? names.filter((name) => name !== options.exclude)
    : names;
  const pool = candidates.length > 0 ? candidates : names;
  return pool[Math.floor(random() * pool.length)] ?? names[0] ?? "";
}

export function pickAssistantName(
  signals: NamingSignals = readHostNamingSignals(),
  options: { exclude?: string; random?: () => number } = {},
): { name: string; pool: ResolvedAssistantNamePool } {
  const pool = resolveAssistantNamePool(signals);
  return {
    name: pickNameFromPool(pool.names, options),
    pool,
  };
}

/**
 * Six unique names sampled from the resolved locale pool (all personality
 * groups). Stable per call; callers memoize when they need a fixed set.
 */
export function sampleSuggestionNames(
  signals: NamingSignals = readHostNamingSignals(),
  random: () => number = Math.random,
): string[] {
  const pool = [...resolveAssistantNamePool(signals).names];
  const count = Math.min(SUGGESTION_COUNT, pool.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}

export function formatNamingFunnelScreen(
  naming: AssistantNamingChoice,
): string {
  return `${naming.source}:${naming.region}:${naming.signal}`;
}

export const RESEARCH_NAMING_VARIANTS = {
  surpriseMe: "locale_surprise_me",
  custom: "custom_name",
} as const;
