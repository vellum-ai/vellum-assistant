import { localizedOrDefault } from "../util/language-subtag.js";

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
  const phrases = localizedOrDefault(
    PROGRESS_FALLBACK_PHRASES_BY_LANGUAGE,
    language,
    PROGRESS_FALLBACK_PHRASES,
  );
  return phrases[counter % phrases.length];
}

// Spoken once when a turn starts waiting on the user's approval decision.
// Fixed rather than generated: this is a statement about the system's
// state, not about the work, and it has to be true every time. Kept in the
// shape of the progress phrases it displaces (short, neutral, no claim
// about tools).
export const APPROVAL_PENDING_PHRASE =
  "I need your okay for that one. Take a look.";

// Per-language spellings of the approval-pending phrase, keyed by lowercased
// BCP 47 base subtag, covering the Deepgram code-switching roster
// (DEEPGRAM_MULTI_LANGUAGE_CODES in providers/speech-to-text/deepgram.ts).
// Same invariants as the progress phrases: persona-neutral, no claims about
// running tools or tasks.
export const APPROVAL_PENDING_PHRASE_BY_LANGUAGE: Readonly<
  Record<string, string>
> = {
  en: APPROVAL_PENDING_PHRASE,
  es: "Necesito tu visto bueno para eso. Échale un vistazo.",
  fr: "J'ai besoin de ton accord pour ça. Jette un œil.",
  de: "Dafür brauche ich dein Okay. Schau mal drauf.",
  hi: "इसके लिए मुझे आपकी मंज़ूरी चाहिए। एक नज़र डाल लीजिए।",
  ru: "Для этого мне нужно твоё согласие. Взгляни, пожалуйста.",
  pt: "Preciso do seu ok para isso. Dê uma olhada.",
  ja: "これには許可が必要です。ご確認ください。",
  it: "Mi serve il tuo via libera per questo. Dai un'occhiata.",
  nl: "Hiervoor heb ik je akkoord nodig. Kijk even mee.",
};

// The approval-pending phrase in the turn's spoken language, defaulting to
// English for unknown or absent languages.
export function approvalPendingPhraseFor(language?: string): string {
  return localizedOrDefault(
    APPROVAL_PENDING_PHRASE_BY_LANGUAGE,
    language,
    APPROVAL_PENDING_PHRASE,
  );
}
