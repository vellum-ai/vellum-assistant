/**
 * The fixed golden prompt set. Keep this stable — changing prompts breaks
 * comparability across runs. Add new prompts; don't edit existing ones.
 */

import type { GoldenPrompt } from "./types.js";

export const GOLDEN_PROMPTS: readonly GoldenPrompt[] = [
  {
    id: "habit-tracker",
    label: "Habit tracker",
    prompt:
      "Build me a habit tracker where I can add daily habits and check them off, with a streak counter.",
  },
  {
    id: "finance-dashboard",
    label: "Finance dashboard",
    prompt:
      "Build a personal finance dashboard showing spending by category with a chart and a recent-transactions list.",
  },
  {
    id: "slide-deck",
    label: "Slide deck",
    prompt:
      "Build a 5-slide deck pitching a coffee subscription startup, with a title slide and presenter navigation.",
  },
  {
    id: "calculator",
    label: "Calculator",
    prompt:
      "Build a calculator with the standard arithmetic operations and a clean keypad layout.",
  },
] as const;
