/**
 * Research-results step: copy and the visible claims list must agree, and an
 * empty list must not keep the user on this card.
 *
 * Aggregator filtering can leave nothing to show; pruning can empty the list
 * the same way. The settled empty card is not rendered. Pruning the last row
 * continues automatically. A research turn that settled empty is skipped by
 * the route (see research-onboarding-route.test.tsx) so this step does not
 * continue on an empty mount (that would walk past a hatch-error hold).
 *
 * Single-file `bun test` only: `mock.module` leaks across files in this repo,
 * so run this file on its own (or via scripts/run-tests.ts).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactElement, type ReactNode } from "react";

import onboardingEn from "@/i18n/locales/en/onboarding.json";
import {
  parseResearchResultStreaming,
  type ResearchFact,
} from "@/utils/research-facts";

// Presence exit holds removed rows in happy-dom for the animation duration.
// The agreement under test is copy vs the surviving list, so mount/unmount
// has to be synchronous.
mock.module("motion/react", () => {
  const MOTION_ONLY_PROPS = new Set([
    "initial",
    "animate",
    "exit",
    "transition",
    "variants",
    "layout",
    "layoutId",
  ]);
  return {
    motion: new Proxy(
      {} as Record<string, (props: Record<string, unknown>) => ReactElement>,
      {
        get: (_target, tag) => (props: Record<string, unknown>) => {
          const domProps: Record<string, unknown> = {};
          for (const key in props) {
            if (!MOTION_ONLY_PROPS.has(key)) {
              domProps[key] = props[key];
            }
          }
          return createElement(String(tag), domProps);
        },
      },
    ),
    AnimatePresence: ({ children }: { children?: ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

const { ResearchResultsStep } =
  await import("@/domains/onboarding/screens/research-result-steps");

const COPY = onboardingEn.researchResultsStep;

const KEPT_CLAIM: ResearchFact = {
  claim: "Engineer at Acme",
  confidence: "confident",
  sources: ["https://acme.example.com/team"],
};

function renderStep(
  props: Partial<Parameters<typeof ResearchResultsStep>[0]> = {},
) {
  return render(
    <ResearchResultsStep
      claims={[]}
      loading={false}
      onContinue={() => {}}
      onRejectAll={() => {}}
      onBack={() => {}}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe("ResearchResultsStep copy / list agreement", () => {
  test("empty-after-filter does not paint the results card", () => {
    const { claims, droppedClaims } = parseResearchResultStreaming(
      JSON.stringify({
        claims: [
          {
            claim: "Lives in Dallas",
            confidence: "confident",
            sources: ["https://spokeo.com/example-user"],
          },
          {
            claim: "Works at Acme",
            confidence: "maybe",
            sources: ["https://whitepages.com/example-user"],
          },
        ],
        suggestions: [],
      }),
    );

    expect(claims).toEqual([]);
    expect(droppedClaims).toEqual(["Lives in Dallas", "Works at Acme"]);

    const onContinue = mock((_removed: string[]) => {});
    renderStep({ claims, loading: false, onContinue });

    expect(screen.queryByText(COPY.title)).toBeNull();
    expect(screen.queryByText(COPY.bodyReadyWithClaims)).toBeNull();
    expect(screen.queryByText("Lives in Dallas")).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.notMe })).toBeNull();
    // The route skips this step when research settles empty. Continuing from
    // an empty mount would mark findings reviewed and walk past a hatch-error
    // hold.
    expect(onContinue).not.toHaveBeenCalled();
  });

  test("visible claims use the results copy and stay in the document", () => {
    renderStep({
      claims: [
        KEPT_CLAIM,
        {
          claim: "Into climbing",
          confidence: "guessing",
          sources: [],
        },
      ],
      loading: false,
    });

    expect(screen.getByText(COPY.bodyReadyWithClaims)).toBeTruthy();
    expect(screen.getByText("Engineer at Acme")).toBeTruthy();
    expect(screen.getByText("Into climbing")).toBeTruthy();
    expect(screen.getByRole("button", { name: COPY.notMe })).toBeTruthy();
  });

  test("pruning the last visible claim advances instead of showing an empty card", () => {
    const onContinue = mock((_removed: string[]) => {});
    renderStep({ claims: [KEPT_CLAIM], loading: false, onContinue });

    expect(screen.getByText(COPY.bodyReadyWithClaims)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: COPY.removeClaim.replace("{claim}", KEPT_CLAIM.claim),
      }),
    );

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue.mock.calls[0]?.[0]).toEqual([KEPT_CLAIM.claim]);
    expect(screen.queryByText(COPY.title)).toBeNull();
    expect(screen.queryByText(COPY.bodyReadyWithClaims)).toBeNull();
    expect(screen.queryByText(KEPT_CLAIM.claim)).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.notMe })).toBeNull();
  });
});
