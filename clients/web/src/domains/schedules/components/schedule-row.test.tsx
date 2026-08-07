/**
 * Tests for ScheduleRow's plugin-sourced treatment: rows whose schedule
 * carries a `sourceKey` render a plugin-name badge while keeping the enabled
 * toggle; user-created rows render no badge.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ScheduleRow } from "./schedule-row";
import { makeSchedule } from "./schedule-test-fixtures";

afterEach(cleanup);

describe("ScheduleRow plugin attribution", () => {
  test("renders a plugin-name badge when the schedule is plugin-sourced", () => {
    const { getByText } = render(
      <ScheduleRow
        schedule={makeSchedule({ sourceKey: "plugin:gmail/poll-inbox" })}
        usage={{ status: "error" }}
        onClick={() => {}}
        onToggle={() => {}}
      />,
    );

    expect(getByText("gmail")).toBeTruthy();
  });

  test("renders no badge for a user-created schedule", () => {
    const { queryByText } = render(
      <ScheduleRow
        schedule={makeSchedule()}
        usage={{ status: "error" }}
        onClick={() => {}}
        onToggle={() => {}}
      />,
    );

    expect(queryByText("gmail")).toBeNull();
  });

  test("keeps the enabled toggle on a plugin-sourced row", () => {
    const onToggle = mock(() => {});
    const { getByLabelText } = render(
      <ScheduleRow
        schedule={makeSchedule({
          sourceKey: "plugin:gmail/poll-inbox",
          enabled: true,
        })}
        usage={{ status: "error" }}
        onClick={() => {}}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(getByLabelText("Toggle Daily digest"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
