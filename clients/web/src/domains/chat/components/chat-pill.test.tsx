import { describe, test } from "bun:test";

// These tests require bun:test + @testing-library/jest-dom integration
// (toBeInTheDocument, toHaveAttribute, toHaveTextContent matchers).
// Convert from test.todo to test once the test infrastructure is set up.

describe("ChatPill", () => {
  test.todo("renders as a button when onClick is provided", () => {});
  test.todo("renders as a non-interactive element when onClick is omitted", () => {});
  test.todo("applies the lifted-surface chrome by default", () => {});
  test.todo("applies the negative tone for the error variant", () => {});
  test.todo("applies pointer-events-auto so it stays interactive over a pointer-events-none overlay", () => {});
  test.todo("invokes onClick when the button variant is activated", () => {});
});
