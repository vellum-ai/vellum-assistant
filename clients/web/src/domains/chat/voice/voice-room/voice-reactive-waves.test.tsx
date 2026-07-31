/**
 * Tests for `VoiceReactiveWaves`.
 *
 * These exist for one reason: to pin down the property the old sine band
 * lacked. That band authored its silhouette once at mount and only slid it
 * sideways, so it drew the same shape whether the mic was clipping or muted —
 * the "it looks like a PNG" report this component was written to answer.
 *
 * So the assertions are about the *geometry* (`d`), not about the CSS var:
 * writing `--voice-amp` is exactly what the old band already did. If a future
 * change reverts to pre-authored paths, the silence-vs-speech comparison below
 * is what should fail.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render, waitFor } from "@testing-library/react";

import { VoiceReactiveWaves } from "./voice-reactive-waves";

afterEach(() => {
  cleanup();
});

/** The rendered path geometry, back-to-front. */
function paths(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<SVGPathElement>("path[data-reactive-wave]"),
  ).map((p) => p.getAttribute("d") ?? "");
}

/** Wait until the rAF loop has drawn at least one frame into every layer. */
async function waitForFirstFrame(container: HTMLElement): Promise<string[]> {
  await waitFor(() => {
    const drawn = paths(container);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((d) => d.length > 0)).toBe(true);
  });
  return paths(container);
}

/**
 * The peak crest height of a filled path, in viewBox units above the floor.
 *
 * The path closes down to y=200, so the smallest y in the curve is the tallest
 * crest. Parsing the numbers straight out of the `d` string keeps this honest
 * about what actually got rendered.
 */
function crestHeight(d: string): number {
  const ys = Array.from(d.matchAll(/[,\s](-?\d+\.?\d*)(?=[\sCLZ]|$)/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  return ys.length > 0 ? 200 - Math.min(...ys) : 0;
}

describe("VoiceReactiveWaves", () => {
  test("renders one path per layer and fills them from the animation loop", async () => {
    const { container } = render(<VoiceReactiveWaves getAmplitude={() => 0} />);

    // Nothing is authored at mount — a placeholder shape would be a silhouette
    // that is not the signal, which is the bug this component fixes.
    expect(paths(container)).toEqual(["", "", ""]);

    const drawn = await waitForFirstFrame(container);
    expect(drawn).toHaveLength(3);
  });

  test("mirrored placements draw both halves", async () => {
    const { container } = render(
      <VoiceReactiveWaves getAmplitude={() => 0.5} placement="inline" />,
    );
    const drawn = await waitForFirstFrame(container);
    // Three layers per half, both halves fed from the same histories.
    expect(drawn).toHaveLength(6);
  });

  test("loud speech raises taller crests than silence", async () => {
    const loud = render(<VoiceReactiveWaves getAmplitude={() => 1} />);
    const quiet = render(<VoiceReactiveWaves getAmplitude={() => 0} />);

    await waitForFirstFrame(loud.container);
    await waitForFirstFrame(quiet.container);

    // Let the history fill so the crest reflects the sustained level rather
    // than the smoother's first few milliseconds of attack.
    await waitFor(
      () => {
        const loudCrest = Math.max(...paths(loud.container).map(crestHeight));
        expect(loudCrest).toBeGreaterThan(40);
      },
      { timeout: 3000 },
    );

    const loudCrest = Math.max(...paths(loud.container).map(crestHeight));
    const quietCrest = Math.max(...paths(quiet.container).map(crestHeight));

    // The whole point: the silhouette is a function of the signal. Silence
    // keeps only the small resting sway, so the gap is large, not marginal.
    expect(loudCrest).toBeGreaterThan(quietCrest * 3);
  });

  test("geometry keeps changing frame to frame while audio is flowing", async () => {
    // A moving signal, so the history scrolls a genuinely different terrain.
    let t = 0;
    const { container } = render(
      <VoiceReactiveWaves
        getAmplitude={() => {
          t += 1;
          return 0.5 + 0.5 * Math.sin(t / 4);
        }}
      />,
    );

    const first = await waitForFirstFrame(container);
    await waitFor(() => {
      // Any layer redrawing differently proves the path is regenerated rather
      // than translated by CSS.
      expect(paths(container).some((d, i) => d !== first[i])).toBe(true);
    });
  });

  test("still emits --voice-amp for the placement CSS", async () => {
    const { container } = render(
      <VoiceReactiveWaves getAmplitude={() => 0.8} />,
    );
    const band = container.querySelector<HTMLElement>(
      ".voice-listening-waves",
    )!;
    await waitFor(() => {
      expect(Number(band.style.getPropertyValue("--voice-amp"))).toBeGreaterThan(
        0,
      );
    });
  });

  test("opts out of the drift keyframe the sine band relies on", async () => {
    const { container } = render(
      <VoiceReactiveWaves getAmplitude={() => 0.5} />,
    );
    // The reactive modifier is what switches `voice-wave-drift` off in CSS;
    // leaving it on would slide the terrain a second time.
    expect(
      container.querySelector(".voice-listening-waves--reactive"),
    ).not.toBeNull();
  });
});
