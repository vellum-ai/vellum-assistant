import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import userEvent from "@testing-library/user-event";

import { cleanup, render, screen } from "@/test-utils.js";

const createScheduleMock = mock(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve([]),
);

mock.module("@/lib/schedules/api.js", () => ({
  createSchedule: createScheduleMock,
}));

import { CreateScheduleModal } from "@/domains/settings/schedules/create-schedule-modal.js";

beforeEach(() => {
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
  createScheduleMock.mockClear();
  createScheduleMock.mockImplementation(() => Promise.resolve([]));
});
afterEach(cleanup);

const baseProps = {
  isOpen: true,
  assistantId: "asst_test",
  onClose: mock(() => {}),
  onCreated: mock(() => {}),
};

describe("CreateScheduleModal", () => {
  test("submit is disabled until name, expression, and message are filled", async () => {
    render(<CreateScheduleModal {...baseProps} />);
    const submit = screen.getByRole("button", { name: /create schedule/i });
    expect(submit).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/morning briefing/i), "D");
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText("0 9 * * *"), "9h");
    expect(submit).toBeDisabled();

    await user.type(
      screen.getByPlaceholderText(/what should the assistant do/i),
      "hi",
    );
    expect(submit).not.toBeDisabled();
  });

  test("clicking a cron preset fills the expression field", async () => {
    render(<CreateScheduleModal {...baseProps} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /every hour/i }));
    const expressionInput = screen.getByPlaceholderText("0 9 * * *");
    expect((expressionInput as HTMLInputElement).value).toBe("0 * * * *");
  });

  test("submit calls createSchedule with trimmed payload and fires onCreated", async () => {
    const onCreated = mock(() => {});
    render(<CreateScheduleModal {...baseProps} onCreated={onCreated} />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(/morning briefing/i), " Dp ");
    await user.type(screen.getByPlaceholderText("0 9 * * *"), " 9h ");
    await user.type(
      screen.getByPlaceholderText(/america\/new_york/i),
      " UTC ",
    );
    await user.type(
      screen.getByPlaceholderText(/what should the assistant do/i),
      " rpt ",
    );

    await user.click(
      screen.getByRole("button", { name: /create schedule/i }),
    );

    expect(createScheduleMock).toHaveBeenCalledTimes(1);
    expect(createScheduleMock).toHaveBeenCalledWith("asst_test", {
      name: "Dp",
      expression: "9h",
      message: "rpt",
      timezone: "UTC",
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  test("omits timezone from payload when blank", async () => {
    render(<CreateScheduleModal {...baseProps} />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(/morning briefing/i), "x");
    await user.type(screen.getByPlaceholderText("0 9 * * *"), "0 9 * * *");
    await user.type(
      screen.getByPlaceholderText(/what should the assistant do/i),
      "hi",
    );
    await user.click(
      screen.getByRole("button", { name: /create schedule/i }),
    );

    expect(createScheduleMock).toHaveBeenCalledWith("asst_test", {
      name: "x",
      expression: "0 9 * * *",
      message: "hi",
    });
  });

  test("surfaces API error and does not call onCreated on failure", async () => {
    createScheduleMock.mockImplementation(() =>
      Promise.reject(new Error("expression could not be parsed")),
    );
    const onCreated = mock(() => {});
    render(<CreateScheduleModal {...baseProps} onCreated={onCreated} />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText(/morning briefing/i), "x");
    await user.type(screen.getByPlaceholderText("0 9 * * *"), "bad");
    await user.type(
      screen.getByPlaceholderText(/what should the assistant do/i),
      "hi",
    );
    await user.click(
      screen.getByRole("button", { name: /create schedule/i }),
    );

    expect(onCreated).not.toHaveBeenCalled();
    expect(
      screen.getByText(/expression could not be parsed/i),
    ).toBeTruthy();
  });
});
