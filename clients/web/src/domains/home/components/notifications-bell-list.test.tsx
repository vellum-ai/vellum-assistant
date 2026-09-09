/**
 * Tests for `NotificationsBellList`.
 *
 * The rows it lists are transparent and swipe. Their swipe wrapper backs a
 * sliding row with `--swipe-item-surface`, and only the host knows what that
 * colour is, so the list has to name it. A restyle that drops it fails
 * nothing else: the action layer simply shows through a swiped row on touch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { feedItem } from "../feed-test-fixtures";
import { NotificationsBellList } from "./notifications-bell-list";

afterEach(cleanup);

describe("NotificationsBellList", () => {
  test("names the surface its rows sit on for the swipe wrapper", () => {
    render(
      <NotificationsBellList
        items={[feedItem({ id: "n1", title: "Weekly report is due" })]}
        maxHeight="400px"
        onSelect={() => {}}
        onDismiss={() => {}}
        onToggleRead={() => {}}
      />,
    );

    // The sheet and the popover that hold the list both paint `--surface-lift`.
    expect(screen.getByTestId("notifications-bell-list").className).toContain(
      "[--swipe-item-surface:var(--surface-lift)]",
    );
  });
});
