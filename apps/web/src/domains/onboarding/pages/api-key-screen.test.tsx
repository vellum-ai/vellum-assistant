import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

let searchParams = new URLSearchParams();
const navigateMock = mock(() => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const { ApiKeyScreen } = await import(
  "@/domains/onboarding/pages/api-key-screen"
);
const { setPendingProviderKey, peekPendingProviderKey } = await import(
  "@/domains/onboarding/provider-key"
);
const { routes } = await import("@/utils/routes");

beforeEach(() => {
  searchParams = new URLSearchParams();
  sessionStorage.clear();
  navigateMock.mockClear();
});

afterEach(() => {
  cleanup();
});

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
}

describe("ApiKeyScreen — openai-compatible", () => {
  test("shows Base URL + Models inputs and an optional API-key field", () => {
    setPendingProviderKey({ provider: "openai-compatible", key: "" });
    render(<ApiKeyScreen />);

    expect(
      screen.getByPlaceholderText("https://api.example.com/v1"),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("model-1, model-2")).toBeTruthy();
    expect(
      screen.getByLabelText("OpenAI-compatible API Key (optional)"),
    ).toBeTruthy();
  });

  test("Continue stays disabled until a base URL and at least one model are entered", () => {
    setPendingProviderKey({ provider: "openai-compatible", key: "" });
    render(<ApiKeyScreen />);

    expect(continueButton().disabled).toBe(true);

    // Entering only an API key does not enable it.
    fireEvent.change(
      screen.getByLabelText("OpenAI-compatible API Key (optional)"),
      { target: { value: "sk-test" } },
    );
    expect(continueButton().disabled).toBe(true);

    // Base URL alone is not enough.
    fireEvent.change(
      screen.getByPlaceholderText("https://api.example.com/v1"),
      { target: { value: "http://localhost:1234/v1" } },
    );
    expect(continueButton().disabled).toBe(true);

    // Adding a model enables Continue.
    fireEvent.change(screen.getByPlaceholderText("model-1, model-2"), {
      target: { value: "local-model" },
    });
    expect(continueButton().disabled).toBe(false);
  });

  test("persists baseUrl + models on the pending key and navigates to privacy", () => {
    setPendingProviderKey({ provider: "openai-compatible", key: "" });
    render(<ApiKeyScreen />);

    fireEvent.change(
      screen.getByPlaceholderText("https://api.example.com/v1"),
      { target: { value: "http://localhost:1234/v1" } },
    );
    fireEvent.change(screen.getByPlaceholderText("model-1, model-2"), {
      target: { value: "local-model" },
    });

    fireEvent.click(continueButton());

    const pending = peekPendingProviderKey();
    expect(pending?.provider).toBe("openai-compatible");
    expect(pending?.baseUrl).toBe("http://localhost:1234/v1");
    expect(pending?.models).toEqual(["local-model"]);
    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.privacy);
  });
});

describe("ApiKeyScreen — keyed provider", () => {
  test("anthropic requires the key and renders no Base URL/Models inputs", () => {
    setPendingProviderKey({ provider: "anthropic", key: "" });
    render(<ApiKeyScreen />);

    expect(
      screen.queryByPlaceholderText("https://api.example.com/v1"),
    ).toBeNull();
    expect(screen.queryByPlaceholderText("model-1, model-2")).toBeNull();
    expect(screen.getByLabelText("Anthropic API Key")).toBeTruthy();

    expect(continueButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Anthropic API Key"), {
      target: { value: "sk-ant-123" },
    });
    expect(continueButton().disabled).toBe(false);
  });
});
