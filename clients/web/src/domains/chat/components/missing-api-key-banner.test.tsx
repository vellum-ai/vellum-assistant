import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { MissingApiKeyBanner } from "@/domains/chat/components/missing-api-key-banner";

afterEach(cleanup);

describe("MissingApiKeyBanner", () => {
  test("missing-key variant offers Settings and no default-model action", () => {
    const onOpenSettings = mock(() => {});
    const onUseDefaultModel = mock(() => {});

    render(
      <MissingApiKeyBanner
        onOpenSettings={onOpenSettings}
        onDismiss={() => {}}
        onUseDefaultModel={onUseDefaultModel}
      />,
    );

    expect(screen.getByTestId("missing-api-key-banner")).toBeTruthy();
    expect(screen.queryByTestId("invalid-api-key-banner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Use default model" })).toBe(
      null,
    );
    expect(onUseDefaultModel).not.toHaveBeenCalled();
  });

  test("invalid-key variant offers Settings and Use default model", () => {
    const onOpenSettings = mock(() => {});
    const onUseDefaultModel = mock(() => {});

    render(
      <MissingApiKeyBanner
        variant="invalid"
        onOpenSettings={onOpenSettings}
        onDismiss={() => {}}
        onUseDefaultModel={onUseDefaultModel}
      />,
    );

    expect(screen.getByTestId("invalid-api-key-banner")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Use default model" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onUseDefaultModel).toHaveBeenCalledTimes(1);
  });

  test("invalid-key variant hides Use default model when no handler is provided", () => {
    render(
      <MissingApiKeyBanner
        variant="invalid"
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByTestId("invalid-api-key-banner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use default model" })).toBe(
      null,
    );
  });
});
