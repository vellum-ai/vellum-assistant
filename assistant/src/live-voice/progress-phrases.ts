import { baseLanguageSubtag } from "../util/language-subtag.js";

// Static fallbacks for an idle-triggered progress narration whose LLM
// phrasing failed — the one case where prolonged silence is actively harmful.
// The idle trigger can fire on a slow turn with zero tool activity, so every
// phrase stays strictly neutral: no claims about running tools or tasks.
// Persona-neutral, no domain content, ≤ 8 words.
// Exported so tests can assert the neutrality invariant against the list.
export const PROGRESS_FALLBACK_PHRASES: readonly string[] = [
  "Still on it — one moment.",
  "Still thinking this through.",
  "Almost there — thanks for waiting.",
];

// Per-language fallback phrases, keyed by lowercased BCP 47 base subtag,
// covering the Deepgram code-switching roster (DEEPGRAM_MULTI_LANGUAGE_CODES
// in providers/speech-to-text/deepgram.ts). Every list carries the same
// invariants as the English one above: persona-neutral, no claims about
// running tools or tasks, at most 8 words per phrase.
export const PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE: Readonly<
  Record<string, readonly string[]>
> = {
  en: PROGRESS_FALLBACK_PHRASES,
  es: [
    "Sigo en ello, un momento.",
    "Todavía lo estoy pensando.",
    "Casi listo, gracias por esperar.",
  ],
  fr: [
    "J'y suis encore, un instant.",
    "J'y réfléchis encore.",
    "Presque fini, merci de patienter.",
  ],
  de: [
    "Bin noch dabei, einen Moment.",
    "Ich denke noch darüber nach.",
    "Fast fertig, danke fürs Warten.",
  ],
  hi: [
    "बस एक पल रुकिए।",
    "अभी इस पर विचार चल रहा है।",
    "बस थोड़ा और इंतज़ार कीजिए, धन्यवाद।",
  ],
  ru: [
    "Секундочку, я ещё здесь.",
    "Я всё ещё думаю над этим.",
    "Почти готово, спасибо за ожидание.",
  ],
  pt: [
    "Ainda estou nisso, um momento.",
    "Ainda estou pensando nisso.",
    "Quase lá, agradeço a espera.",
  ],
  ja: [
    "まだ対応中です。少々お待ちください。",
    "まだ考えているところです。",
    "もうすぐです。お待ちいただきありがとうございます。",
  ],
  it: [
    "Ancora un attimo, per favore.",
    "Ci sto ancora pensando.",
    "Quasi fatto, grazie per l'attesa.",
  ],
  nl: [
    "Ik ben er nog mee bezig.",
    "Ik denk er nog over na.",
    "Bijna klaar, bedankt voor het wachten.",
  ],
};

// Deterministic rotation through the phrase list: callers hold a nonnegative
// monotonic counter, so consecutive picks vary while tests stay reproducible.
// `language` selects the per-language list by its lowercased base subtag
// (e.g. "pt-BR" -> "pt"); unknown or absent languages fall back to English.
export function pickProgressPhrase(counter: number, language?: string): string {
  const base = baseLanguageSubtag(language);
  const phrases =
    (base !== undefined
      ? PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE[base]
      : undefined) ?? PROGRESS_FALLBACK_PHRASES;
  return phrases[counter % phrases.length];
}
