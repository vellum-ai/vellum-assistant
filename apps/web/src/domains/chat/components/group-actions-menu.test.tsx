/**
 * Tests for `GroupActionsMenu` (custom-conversation-group rename/delete
 * menu) — the mobile vs desktop branch.
 *
 * Desktop renders a Radix Popover; mobile renders a Radix Dialog
 * (BottomSheet). Both surfaces include Rename and Delete rows when the
 * corresponding callback is supplied.
 *
 * These tests require a DOM environment (happy-dom or jsdom) and
 * @testing-library/jest-dom matchers. Convert from test.todo to test
 * once the test infrastructure is set up.
 */

import { describe, test } from "bun:test";

describe("GroupActionsMenu", () => {
  test.todo(
    "desktop branch: renders Popover content with Rename and Delete rows",
    () => {},
  );
  test.todo(
    "mobile branch: renders BottomSheet (role=dialog) with Rename and Delete rows",
    () => {},
  );
});
