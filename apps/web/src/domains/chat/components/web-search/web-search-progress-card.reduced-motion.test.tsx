/**
 * Reduced-motion contract for `WebSearchProgressCard`'s header step
 * carousel. Split out from the main test file because `mock.module` of
 * `motion/react` leaks across files in the same test run — colocating it
 * with the main suite breaks downstream `motion/react`-using suites
 * (`ToolCallProgressCard.test.tsx` was the canary). Mirrors the isolation
 * pattern used by `website-carousel.test.tsx`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

describe("WebSearchProgressCard — reduced motion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("renders the header step carousel without a y transform when prefers-reduced-motion is set", async () => {
    const motionSpanCalls: Array<Record<string, unknown>> = [];
    mock.module("motion/react", () => {
      const motionSpan = ({
        children,
        animate,
        initial,
        exit,
        transition,
        // Strip motion-only props so they don't leak onto the DOM <span>
        // as unknown attributes (would log a React warning).
        ...rest
      }: {
        children?: React.ReactNode;
        animate?: Record<string, unknown>;
        initial?: Record<string, unknown>;
        exit?: Record<string, unknown>;
        transition?: Record<string, unknown>;
        [key: string]: unknown;
      }) => {
        motionSpanCalls.push({ animate, initial, exit, transition });
        const { key: _k, ...domRest } = rest;
        return <span {...domRest}>{children}</span>;
      };
      // Passthrough motion.div so downstream suites that mount any
      // `motion.div`-using component while this mock is still in place
      // (bun's `mock.module` bleeds across files in the same run) don't
      // crash on `undefined` element types.
      const motionDiv = ({
        children,
        animate: _a,
        initial: _i,
        exit: _e,
        transition: _t,
        ...rest
      }: {
        children?: React.ReactNode;
        animate?: unknown;
        initial?: unknown;
        exit?: unknown;
        transition?: unknown;
        [key: string]: unknown;
      }) => <div {...rest}>{children}</div>;
      return {
        motion: { div: motionDiv, span: motionSpan },
        AnimatePresence: ({ children }: { children?: React.ReactNode }) => (
          <>{children}</>
        ),
        useReducedMotion: () => true,
      };
    });

    const { WebSearchProgressCard: PatchedCard } = await import(
      "./web-search-progress-card"
    );
    render(
      <PatchedCard
        currentStepTitle="Searching the web"
        currentStepInfo="alpha"
        stepCount="1 step"
        steps={[]}
      />,
    );

    // At least the header carousel motion.span should have been rendered.
    expect(motionSpanCalls.length).toBeGreaterThan(0);
    const props = motionSpanCalls[0]!;
    // The reduced-motion branch must drop the y offsets — opacity-only fade.
    expect((props.initial as Record<string, unknown>).y).toBeUndefined();
    expect((props.animate as Record<string, unknown>).y).toBeUndefined();
    expect((props.exit as Record<string, unknown>).y).toBeUndefined();
    // Transition collapses to an instantaneous 0-duration fade.
    expect((props.transition as Record<string, unknown>).duration).toBe(0);
  });
});
