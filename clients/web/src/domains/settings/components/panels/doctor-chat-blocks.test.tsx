import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FeedbackPromptBlock } from "@/domains/settings/components/panels/doctor-chat-blocks";

afterEach(() => {
  cleanup();
});

describe("FeedbackPromptBlock", () => {
  test("renders a Share Feedback button that opens feedback", () => {
    const onOpenFeedback = mock();

    render(<FeedbackPromptBlock onOpenFeedback={onOpenFeedback} />);

    const button = screen.getByRole("button", { name: "Share Feedback" });
    fireEvent.click(button);

    expect(onOpenFeedback).toHaveBeenCalledTimes(1);
  });
});
