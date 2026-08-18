/**
 * Tests for ScheduleRow's plugin-sourced treatment: rows whose schedule
 * carries a `sourceKey` render a plugin-name badge while keeping the enabled
 * toggle; user-created rows render no badge. An off row says why it is off
 * when the daemon tells it.
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

describe("ScheduleRow disarm reason", () => {
  test("an off row says why it is off", () => {
    const { getByText } = render(
      <ScheduleRow
        schedule={makeSchedule({
          sourceKey: "plugin:gmail/poll-inbox",
          enabled: false,
          disarmReason: "plugin_disabled",
        })}
        usage={{ status: "error" }}
        onClick={() => {}}
        onToggle={() => {}}
      />,
    );

    expect(getByText("plugin disabled")).toBeTruthy();
  });

  test("an armed row shows no reason", () => {
    const { queryByText } = render(
      <ScheduleRow
        schedule={makeSchedule({
          sourceKey: "plugin:gmail/poll-inbox",
          enabled: true,
          disarmReason: null,
        })}
        usage={{ status: "error" }}
        onClick={() => {}}
        onToggle={() => {}}
      />,
    );

    expect(queryByText("plugin disabled")).toBeNull();
    expect(queryByText("turned off by you")).toBeNull();
  });
});
