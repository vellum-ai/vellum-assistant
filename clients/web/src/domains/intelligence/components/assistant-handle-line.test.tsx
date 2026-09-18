import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AssistantHandleLineView } from "./assistant-handle-line";

afterEach(cleanup);

describe("AssistantHandleLineView", () => {
  test("shows the handle and opens the editor when pressed", () => {
    const onEdit = mock(() => {});
    render(<AssistantHandleLineView handle="ada" onEdit={onEdit} />);

    const line = screen.getByRole("button", { name: "Edit handle @ada" });
    expect(line.textContent).toBe("@ada");

    fireEvent.click(line);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("keeps its place but leaves the tab order while hidden", () => {
    render(<AssistantHandleLineView handle="ada" onEdit={() => {}} hidden />);

    expect(screen.queryByRole("button")).toBeNull();
    const line = screen.getByText("@ada").closest("button");
    expect(line?.getAttribute("tabindex")).toBe("-1");
  });
});
