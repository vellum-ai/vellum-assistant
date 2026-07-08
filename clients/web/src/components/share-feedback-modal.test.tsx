import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

import { ShareFeedbackModal } from "@/components/share-feedback-modal";

afterEach(() => {
  cleanup();
});

describe("ShareFeedbackModal", () => {
  test("prefills the feedback message", () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="other"
          initialMessage="The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    expect(
      (screen.getByLabelText("What's on your mind?") as HTMLTextAreaElement)
        .value,
    ).toBe("The app colors are ugly.");
  });
});
