/**
 * The parser and `useParams` read the same URL the same way.
 *
 * `conversationIdForPath` / `appIdForPath` stand in for the route params
 * wherever an imperative helper has no hook to call, so a URL the two read
 * differently drops the app out of every route built through
 * `conversation-navigation`. These cases are the ones percent-encoding pulls
 * apart: a malformed escape, which React Router leaves the whole path raw for,
 * and `%2F`, which it restores to `/` inside a param.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";

import { appIdForPath, conversationIdForPath, routes } from "@/utils/routes";

const PARAMS_TEST_ID = "route-params";
// The patterns `routes.tsx` mounts, spelled by the producer that writes them.
const APP_ROUTE = routes.conversation(":conversationId", ":appId");
const CONVERSATION_ROUTE = routes.conversation(":conversationId");

function ParamsProbe() {
  const { conversationId, appId } = useParams<{
    conversationId?: string;
    appId?: string;
  }>();
  return (
    <span data-testid={PARAMS_TEST_ID}>
      {JSON.stringify({
        conversationId: conversationId ?? null,
        appId: appId ?? null,
      })}
    </span>
  );
}

/** What `useParams` yields for `pathname`, through the real router. */
function paramsAt(pathname: string): {
  conversationId: string | null;
  appId: string | null;
} {
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route path={APP_ROUTE} element={<ParamsProbe />} />
        <Route path={CONVERSATION_ROUTE} element={<ParamsProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return JSON.parse(screen.getByTestId(PARAMS_TEST_ID).textContent ?? "{}");
}

afterEach(cleanup);

describe("the parser yields the ids useParams yields", () => {
  const CASES = [
    "/assistant/conversations/conv-1/app/app-1",
    "/assistant/conversations/conv-1",
    // A plugin app takes its id from the author's directory name, so a space
    // reaches the URL encoded.
    "/assistant/conversations/c1/app/plugins~p~My%20App",
    // One malformed escape leaves every segment of the path raw.
    "/assistant/conversations/conv%1/app/My%20App",
    "/assistant/conversations/conv%20x/app/a%1",
    "/assistant/conversations/%E0%A4%A",
    // `%2F` is restored to `/` inside a param, decoded path or raw.
    "/assistant/conversations/c1/app/a%2Fb",
    "/assistant/conversations/conv%1/app/a%2Fb",
    // The router matches on the decoded path, so an escaped prefix matches.
    "/assistant/%63onversations/c1/app/app-1",
  ];

  for (const pathname of CASES) {
    test(pathname, () => {
      expect({
        conversationId: conversationIdForPath(pathname),
        appId: appIdForPath(pathname),
      }).toEqual(paramsAt(pathname));
    });
  }
});
