import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const feedbackRequests: unknown[] = [];

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  feedbackCreateMutation: () => ({
    mutationFn: async (request: unknown) => {
      feedbackRequests.push(request);
      return { id: "feedback-1" };
    },
  }),
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => null,
    },
  },
}));

const { ShareFeedbackModal } = await import("@/components/share-feedback-modal");

afterEach(() => {
  cleanup();
  feedbackRequests.length = 0;
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

  test("submits Doctor session id and transcript diagnostics", async () => {
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
          doctorSessionId="doctor-session-123"
          doctorSessionLog="User: I have feedback\n\nFeedback Prompt: The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    const request = feedbackRequests[0] as {
      body: { doctor_session_id?: string; logs_file?: File };
    };
    expect(request.body.doctor_session_id).toBe("doctor-session-123");

    const logsFile = request.body.logs_file;
    expect(logsFile).toBeInstanceOf(File);
    const logsText = await new Response(
      logsFile!.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(logsText).toContain("doctor-session.txt");
    expect(logsText).toContain("Feedback Prompt: The app colors are ugly.");
  });
});
