import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { ActivityRedirectPage } from "./activity-redirect-page";

afterEach(cleanup);

/** Renders wherever the redirect lands, as a single readable string. */
function Landing() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="landing">{`${pathname}${search}${hash}`}</div>;
}

function landingFor(entry: string): string {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/assistant/home" element={<ActivityRedirectPage />} />
        <Route path="/assistant" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId("landing").textContent ?? "";
}

describe("ActivityRedirectPage", () => {
  test("forwards the legacy Activity URL to the assistant root", () => {
    expect(landingFor("/assistant/home")).toBe("/assistant");
  });

  // A saved link or a login `returnTo` round-trip can carry its own params,
  // and dropping them here would strip the link of everything but its path.
  test("carries the query string and hash across", () => {
    expect(landingFor("/assistant/home?tab=1&item=abc#top")).toBe(
      "/assistant?tab=1&item=abc#top",
    );
  });
});
