/**
 * The parser and `useParams` read the same URL the same way.
 *
 * `conversationIdForPath` / `appIdForPath` stand in for the route params
 * wherever an imperative helper has no hook to call, so a URL the two read
 * differently drops the app out of every route built through
 * `conversation-navigation`. The cases cover a baseline with no encoding, a
 * well-formed escape, a malformed escape in either segment, `%2F` inside a
 * param, and an escaped spelling of the route prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";

import { appIdForPath, conversationIdForPath, routes } from "@/utils/routes";
import {
  ENCODED_APP_PATH,
  ENCODED_SLASH_APP_PATH,
  ESCAPED_PREFIX_APP_PATH,
  MALFORMED_APP_PATH,
  MALFORMED_CONVERSATION_PATH,
  MALFORMED_CONVERSATION_WITH_APP_PATH,
  RAW_ENCODED_SLASH_APP_PATH,
} from "@/utils/routes.test-helper";

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
    routes.conversation("conv-1", "app-1"),
    routes.conversation("conv-1"),
    ENCODED_APP_PATH,
    // One malformed escape leaves every segment of the path raw.
    MALFORMED_CONVERSATION_WITH_APP_PATH,
    MALFORMED_APP_PATH,
    MALFORMED_CONVERSATION_PATH,
    // `%2F` is restored to `/` inside a param, decoded path or raw.
    ENCODED_SLASH_APP_PATH,
    RAW_ENCODED_SLASH_APP_PATH,
    // The router matches on the decoded path, so an escaped prefix matches.
    ESCAPED_PREFIX_APP_PATH,
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
