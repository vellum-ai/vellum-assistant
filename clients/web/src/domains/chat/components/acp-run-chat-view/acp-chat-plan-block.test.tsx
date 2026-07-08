import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { AcpChatPlanBlock } from "./acp-chat-plan-block";

afterEach(cleanup);

describe("AcpChatPlanBlock", () => {
  test("renders a row per entry", () => {
    render(
      <AcpChatPlanBlock
        entries={[
          { label: "Read files", checked: true },
          { label: "Edit files", checked: false },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("acp-chat-plan-entry");
    expect(rows).toHaveLength(2);
    expect(screen.getByText("Read files")).toBeDefined();
    expect(screen.getByText("Edit files")).toBeDefined();
  });

  test("marks checked vs unchecked entries", () => {
    render(
      <AcpChatPlanBlock
        entries={[
          { label: "done", checked: true },
          { label: "todo", checked: false },
        ]}
      />,
    );
    const rows = screen.getAllByTestId("acp-chat-plan-entry");
    expect(rows[0]?.getAttribute("data-checked")).toBe("true");
    expect(rows[1]?.getAttribute("data-checked")).toBe("false");
  });

  test("renders nothing for an empty plan", () => {
    render(<AcpChatPlanBlock entries={[]} />);
    expect(screen.queryByTestId("acp-chat-plan-block")).toBeNull();
  });
});
