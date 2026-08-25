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

  test("normalizes a lowercase brand to its canonical label", () => {
    const { getByTestId } = render(
      <PaymentMethodRow brand="visa" last4="4242" onUpdateCard={() => {}} />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Visa");
    expect(row.textContent).not.toContain("visa");
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

  test("renders a long unmapped brand verbatim", () => {
    const { getByTestId } = render(
      <PaymentMethodRow
        brand="internationalmaestro"
        last4="0005"
        onUpdateCard={() => {}}
      />,
    );
    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("internationalmaestro");
  });

  test("fires onUpdateCard when Update Card is clicked", () => {
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

  test("offers Update Card as the only action", () => {
    const { getByTestId, queryByTestId } = render(
      <PaymentMethodRow brand="Visa" last4="4242" onUpdateCard={() => {}} />,
    );
    expect(getByTestId("payment-method-update")).not.toBeNull();
    expect(queryByTestId("payment-method-remove")).toBeNull();
  });
});
