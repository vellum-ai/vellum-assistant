import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { SecretPromptCard } from "@/domains/chat/components/secret-prompt-card";

function noop() {}

const baseProps = {
  isSubmitting: false,
  saved: false,
  onSave: noop,
  onSendOnce: noop,
  onCancel: noop,
};

describe("SecretPromptCard credential identity line", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders a humanized service · field descriptor", () => {
    render(
      <SecretPromptCard
        {...baseProps}
        secret={{
          requestId: "req-1",
          service: "slack_channel",
          field: "app_token",
        }}
      />,
    );

    expect(screen.queryByText("Slack channel · App token")).not.toBeNull();
  });

  test("renders only the service when field is absent", () => {
    render(
      <SecretPromptCard
        {...baseProps}
        secret={{ requestId: "req-2", service: "slack_channel" }}
      />,
    );

    expect(screen.queryByText("Slack channel")).not.toBeNull();
  });

  test("renders no identity line when both service and field are absent", () => {
    render(
      <SecretPromptCard
        {...baseProps}
        secret={{ requestId: "req-3", label: "API Key" }}
      />,
    );

    expect(screen.queryByText("API Key")).not.toBeNull();
    expect(screen.queryByText("·")).toBeNull();
  });
});
