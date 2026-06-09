import { useEffect, useState } from "react";

import { CastStyle } from "@/cast/cast-style";
import type { Rect } from "@/cast/cast-hero";
import type { StyleProfile } from "@/cast/cast-hooks";
import { buildCharacter } from "@/cast/cast-roster";
import "@/cast/cast.css";

/**
 * Standalone host for the "This or That" beat (`CastStyle`), pulled out of the
 * two-panel cast flow onto its own page so it can be iterated in isolation —
 * navigable at `/assistant/this-that`. Everything here is just scaffolding
 * (a default character + a centered hero box); the actual selections live in
 * `cast-style.tsx`.
 */

const CHARACTER = buildCharacter("flower", "quirky", "orange");

/** Hero box: a small character centered near the top of the surface. */
function centeredBox(): Rect {
  const w = typeof window === "undefined" ? 1280 : window.innerWidth;
  const h = typeof window === "undefined" ? 900 : window.innerHeight;
  const size = Math.max(120, Math.min(176, Math.min(w, h) * 0.2));
  return { left: w / 2 - size / 2, top: h * 0.12, size };
}

export function CastStylePage() {
  const [box, setBox] = useState<Rect>(() => centeredBox());
  const [runId, setRunId] = useState(0);
  const [done, setDone] = useState<StyleProfile | null>(null);

  useEffect(() => {
    const onResize = () => setBox(centeredBox());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function restart() {
    setDone(null);
    setRunId((n) => n + 1);
  }

  return (
    // Dark-only, like the rest of Cast — semantic tokens resolve to dark here.
    <div className="cast-stage" data-theme="dark">
      <div className="cast-panel">
        {done ? (
          <div className="cast-style-done">
            <p className="cast-style-done__title">That's the vibe.</p>
            <p className="cast-style-done__sub">
              {[done.autonomy, done.tone, done.shape]
                .filter(Boolean)
                .map((v) => v!.replace("_", " "))
                .join(" · ")}
            </p>
            <button type="button" className="cast-style-done__btn" onClick={restart}>
              Run again
            </button>
          </div>
        ) : (
          <CastStyle
            key={runId}
            character={CHARACTER}
            name="Vela"
            heroBox={box}
            jobs={[]}
            ascended={false}
            onChoose={(value) => console.log("[this/that] choose", value)}
            onRoundPicked={(style) => console.log("[this/that] round", style)}
            onDone={(style) => setDone(style)}
            onBack={restart}
          />
        )}
      </div>
    </div>
  );
}
