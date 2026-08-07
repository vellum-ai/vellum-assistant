/**
 * Tests for the companion surface's Type gate.
 *
 * The component is presentational, so the flag is not in here: the page reads
 * it and passes the answer down as `canType`. What is asserted is the contract
 * that gate depends on, at the expanded phase where the controls are drawn.
 * Talk is checked alongside Type in both directions, because the gate is only
 * correct if it takes Type and nothing else.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import { CompanionSurface } from "@/components/companion-surface";

afterEach(cleanup);

describe("CompanionSurface Type gate", () => {
  test("offers Talk and Type by default", () => {
    render(<CompanionSurface phase="hover" />);

    expect(screen.getByRole("button", { name: "Talk" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Type" })).toBeDefined();
  });

  test("leaves Talk alone when Type is gated off", () => {
    render(<CompanionSurface phase="hover" canType={false} />);

    expect(screen.getByRole("button", { name: "Talk" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Type" })).toBeNull();
  });
});
