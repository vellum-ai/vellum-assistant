import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { PaymentMethodRow } from "./payment-method-row";

afterEach(cleanup);

describe("PaymentMethodRow", () => {
  test("renders the brand and last4", () => {
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="Visa"
        last4="4242"
        onUpdateCard={() => {}}
        onRemove={() => {}}
      />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Visa");
    expect(row.textContent).toContain("Ending in 4242");
  });

  test("normalizes a lowercase brand to its canonical label", () => {
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="visa"
        last4="4242"
        onUpdateCard={() => {}}
        onRemove={() => {}}
      />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Visa");
    expect(row.textContent).not.toContain("visa");
  });

  test("falls back to a generic label and omits the ending line when null", () => {
    const { getByTestId } = render(
      <PaymentMethodRow
        brand={null}
        last4={null}
        onUpdateCard={() => {}}
        onRemove={() => {}}
      />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Saved card");
    expect(row.textContent).not.toContain("Ending in");
    expect(row.textContent).not.toContain("null");
  });

  test("fires onUpdateCard when Update Card is clicked", () => {
    const onUpdateCard = mock(() => {});
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="Visa"
        last4="4242"
        onUpdateCard={onUpdateCard}
        onRemove={() => {}}
      />,
    );
    fireEvent.click(getByTestId("payment-method-update"));
    expect(onUpdateCard).toHaveBeenCalledTimes(1);
  });

  test("fires onRemove when Remove is clicked", () => {
    const onRemove = mock(() => {});
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="Visa"
        last4="4242"
        onUpdateCard={() => {}}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(getByTestId("payment-method-remove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  test("disables Remove and shows a pending label while removing", () => {
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="Visa"
        last4="4242"
        onUpdateCard={() => {}}
        onRemove={() => {}}
        removing
      />,
    );
    const remove = getByTestId("payment-method-remove") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.textContent).toContain("Removing…");
  });
});
