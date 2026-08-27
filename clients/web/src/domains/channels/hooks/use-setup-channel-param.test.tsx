import { afterEach, describe, expect, test } from "bun:test";
import { useEffect, useState } from "react";

import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { useChannelRouteSelection } from "@/domains/channels/hooks/use-channel-route-selection";
import { useSetupChannelParam } from "@/domains/channels/hooks/use-setup-channel-param";
import type { SetupChannelId } from "@/types/channel-types";

/**
 * Mirrors the ChannelsPage wiring: the page consumes `?setup=<channel>` and
 * the list, a child, freezes it and selects the adapter in a mount effect.
 * The two arrival effects each navigate; this pins that together they
 * resolve to ONE location carrying both intents, so a companion param like
 * `release=1` survives to the panel that consumes it.
 */
function ListHarness({
  initialChannel,
}: {
  initialChannel: SetupChannelId | null;
}) {
  const { select } = useChannelRouteSelection();
  const [setupChannel] = useState(initialChannel);
  useEffect(() => {
    if (setupChannel) {
      select(setupChannel);
    }
  }, [setupChannel, select]);
  return null;
}

function PageHarness() {
  const setupChannel = useSetupChannelParam();
  return <ListHarness initialChannel={setupChannel} />;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{location.pathname + location.search}</div>
  );
}

afterEach(() => {
  cleanup();
});

describe("setup deep-link arrival", () => {
  test("a combined setup=email&release=1 arrival keeps both intents", async () => {
    const { getByTestId } = render(
      <MemoryRouter
        initialEntries={["/assistant/channels?setup=email&release=1"]}
      >
        <Routes>
          <Route
            path="/assistant/channels/:channelId?"
            element={
              <>
                <PageHarness />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getByTestId("location").textContent).toBe(
        "/assistant/channels/email?release=1",
      );
    });
  });

  test("a plain setup arrival lands on the channel with a clean query", async () => {
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/assistant/channels?setup=telegram"]}>
        <Routes>
          <Route
            path="/assistant/channels/:channelId?"
            element={
              <>
                <PageHarness />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getByTestId("location").textContent).toBe(
        "/assistant/channels/telegram",
      );
    });
  });
});
