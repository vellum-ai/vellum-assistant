import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { DomainVerificationChip } from "@/components/domain-verification-chip";

afterEach(() => {
  cleanup();
});

describe("DomainVerificationChip", () => {
  test("shows DNS verification progress only when the provider is waiting on DNS", () => {
    render(<DomainVerificationChip status="pending" isLoading={false} />);

    const chip = screen.getByText("Verifying domain…").closest("span");
    expect(chip?.getAttribute("title")).toBe(
      "DNS records have been provisioned. Waiting for the email provider to verify them - this usually takes a few minutes.",
    );
  });

  test("shows setup required when the domain has not reached the email provider", () => {
    render(<DomainVerificationChip status="not_started" isLoading={false} />);

    const chip = screen.getByText("Domain setup required").closest("span");
    expect(chip?.getAttribute("title")).toBe(
      "This domain has not been provisioned with the email provider. It cannot send or receive email until setup is complete.",
    );
  });
});
