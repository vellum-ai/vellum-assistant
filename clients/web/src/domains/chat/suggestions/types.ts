/**
 * Shared types for the new-thread suggestions library.
 *
 * The data model is intentionally React-free: cards carry string `iconKey`s
 * that the icon resolver maps to brand/lucide components later. Mock data,
 * the suggestion cards, and the detail drawer all import these types.
 */

/** Stable key resolved to a brand/lucide icon by the icon resolver. */
export type SuggestionIconKey =
  | "gmail"
  | "google-calendar"
  | "google-drive"
  | "vellum"
  | "generic";

/** A single requirement shown in the detail drawer "Here's what we'll need". */
export interface SuggestionRequirement {
  id: string;
  label: string;
  /** "ready" = already satisfied (green check); "install" = needs install/connect. */
  status: "ready" | "install";
  /** Optional helper text, e.g. "Need to install this, but it's easy.". */
  hint?: string;
}

/** Full detail content rendered in the right-hand drawer. */
export interface SuggestionDetail {
  /** Drawer heading, e.g. "Email Helper". */
  heading: string;
  /** Paragraph describing the suggestion. */
  description: string;
  requirements: SuggestionRequirement[];
  /** Bulleted "Things we can do" list. */
  capabilities: string[];
}

/** A suggestion card: icon + title, expands to a detail drawer. */
export interface ThreadSuggestion {
  id: string;
  title: string;
  iconKey: SuggestionIconKey;
  /** Prompt submitted when the user picks "Let's do it!". */
  prompt: string;
  detail: SuggestionDetail;
}

/** A titled group of suggestions in the scrollable library. */
export interface SuggestionGroup {
  id: string;
  /** Section heading, e.g. "Your plugins" or "Vellum picks". */
  title: string;
  /** Provenance — drives future real-data sourcing; informational for now. */
  source: "plugin" | "vellum-curated";
  suggestions: ThreadSuggestion[];
}
