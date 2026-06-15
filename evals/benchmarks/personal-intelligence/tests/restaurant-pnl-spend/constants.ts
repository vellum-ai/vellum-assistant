/**
 * Expected answer for the P&L fixture. `assets/restaurant-pnl.csv` must keep
 * "Labor" as the unambiguous largest spend category, or this constant must
 * change with it.
 */
export const LARGEST_SPEND_CATEGORY = "Labor";

/**
 * The non-largest spend categories in the fixture, by a distinctive token the
 * assistant is likely to echo. Used by the grader to detect a *wrong* largest
 * claim (a superlative tied to one of these instead of Labor).
 */
export const OTHER_SPEND_CATEGORIES = [
  "Food",
  "Rent",
  "Utilities",
  "Marketing",
  "Miscellaneous",
];

/**
 * Workspace-relative filename the P&L fixture is staged at before the
 * conversation. Shared by `setup.ts` (which stages it) and the SPEC's
 * file-clarification hint (which points the agent at it).
 */
export const PNL_WORKSPACE_FILENAME = "restaurant-pnl.csv";
