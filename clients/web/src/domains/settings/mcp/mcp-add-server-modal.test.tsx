import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";

import { McpAddServerModal } from "./mcp-add-server-modal";

test("new custom connections default to Streamable HTTP and retain SSE and local setup", () => {
  const { unmount } = render(<McpAddServerModal open onClose={() => {}} onAdd={() => {}} isPending={false} />);
  const transport = screen.getByLabelText("Transport") as HTMLSelectElement;
  expect(transport.value).toBe("streamable-http");
  fireEvent.change(transport, { target: { value: "sse" } });
  expect(transport.value).toBe("sse");
  fireEvent.change(transport, { target: { value: "stdio" } });
  expect(transport.value).toBe("stdio");
  screen.getByLabelText("Command");
  unmount();
});
