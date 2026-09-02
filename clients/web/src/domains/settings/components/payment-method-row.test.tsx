import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { PaymentMethodRow } from "./payment-method-row";

afterEach(cleanup);

describe("PaymentMethodRow", () => {
  test("renders the brand and last4", () => {
    const { getByTestId } = render(
      <PaymentMethodRow brand="Visa" last4="4242" onUpdateCard={() => {}} />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Visa");
    expect(row.textContent).toContain("Ending in 4242");
  });

  test("falls back to a generic label and omits the ending line when null", () => {
    const { getByTestId } = render(
      <PaymentMethodRow brand={null} last4={null} onUpdateCard={() => {}} />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Saved card");
    expect(row.textContent).not.toContain("Ending in");
    expect(row.textContent).not.toContain("null");
  });

  test("renders the expiry after the ending line when both parts are known", () => {
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="visa"
        last4="4242"
        expMonth={4}
        expYear={2042}
        onUpdateCard={() => {}}
      />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Ending in 4242");
    expect(row.textContent).toContain("\u00b7 04 / 42");
  });

  test("omits the expiry when either part is missing", () => {
    const { getByTestId, rerender } = render(
      <PaymentMethodRow
        brand="visa"
        last4="4242"
        expMonth={4}
        expYear={null}
        onUpdateCard={() => {}}
      />,
    );
    expect(getByTestId("payment-method-row").textContent).not.toContain(
      "\u00b7",
    );

    rerender(
      <PaymentMethodRow
        brand="visa"
        last4="4242"
        expMonth={null}
        expYear={2042}
        onUpdateCard={() => {}}
      />,
    );
    expect(getByTestId("payment-method-row").textContent).not.toContain(
      "\u00b7",
    );
  });

  test("omits the expiry when the props are not supplied at all", () => {
    const { getByTestId } = render(
      <PaymentMethodRow brand="visa" last4="4242" onUpdateCard={() => {}} />,
    );
    expect(getByTestId("payment-method-row").textContent).not.toContain(
      "\u00b7",
    );
  });

  test("fires onUpdateCard when Replace card is clicked", () => {
    const onUpdateCard = mock(() => {});
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="Visa"
        last4="4242"
        onUpdateCard={onUpdateCard}
      />,
    );
    fireEvent.click(getByTestId("payment-method-update"));
    expect(onUpdateCard).toHaveBeenCalledTimes(1);
  });

  test("actionsDisabled disables the row's actions", () => {
    const onUpdateCard = mock(() => {});
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="Visa"
        last4="4242"
        onUpdateCard={onUpdateCard}
        actionsDisabled
      />,
    );
    const replace = getByTestId("payment-method-update") as HTMLButtonElement;
    expect(replace.disabled).toBe(true);
    fireEvent.click(replace);
    expect(onUpdateCard).not.toHaveBeenCalled();
  });

  test("leaves the row's actions enabled by default", () => {
    const { getByTestId } = render(
      <PaymentMethodRow brand="Visa" last4="4242" onUpdateCard={() => {}} />,
    );
    expect(
      (getByTestId("payment-method-update") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("offers Replace card as the only action", () => {
    const { getByTestId, queryByTestId } = render(
      <PaymentMethodRow brand="Visa" last4="4242" onUpdateCard={() => {}} />,
    );
    expect(getByTestId("payment-method-update").textContent).toContain(
      "Replace card",
    );
    expect(queryByTestId("payment-method-remove")).toBeNull();
  });
});
