/**
 * Research-results step: copy and the visible claims list must agree.
 *
 * A research turn can settle with card-worthy facts, or with nothing that
 * survived aggregator filtering. Either way the body copy has to match what
 * the list actually renders. Claims that exist must stay in the document, not
 * get clipped out of an overflow region.
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
  test("empty-after-filter uses the empty-state copy and renders no rows", () => {
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

    renderStep({ claims, loading: false });

    expect(screen.getByText(COPY.bodyReadyEmpty)).toBeTruthy();
    expect(screen.queryByText(COPY.bodyReadyWithClaims)).toBeNull();
    expect(screen.queryByText("Lives in Dallas")).toBeNull();
    expect(screen.queryByText("Works at Acme")).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.notMe })).toBeNull();
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
    expect(screen.queryByText(COPY.bodyReadyEmpty)).toBeNull();
    expect(screen.getByText("Engineer at Acme")).toBeTruthy();
    expect(screen.getByText("Into climbing")).toBeTruthy();
    expect(screen.getByRole("button", { name: COPY.notMe })).toBeTruthy();
  });

  test("pruning the last visible claim swaps to the empty-state copy", () => {
    renderStep({ claims: [KEPT_CLAIM], loading: false });

    expect(screen.getByText(COPY.bodyReadyWithClaims)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: COPY.removeClaim.replace("{claim}", KEPT_CLAIM.claim),
      }),
    );

    expect(screen.getByText(COPY.bodyReadyEmpty)).toBeTruthy();
    expect(screen.queryByText(COPY.bodyReadyWithClaims)).toBeNull();
    expect(screen.queryByText(KEPT_CLAIM.claim)).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.notMe })).toBeNull();
  });
});
