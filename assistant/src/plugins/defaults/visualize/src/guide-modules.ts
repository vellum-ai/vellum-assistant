/**
 * Registry of the guidance modules `visualize_guide` can serve, keyed by the
 * module name the model passes in.
 */

import { CHART_GUIDE } from "./guide-chart.js";
import { DIAGRAM_GUIDE } from "./guide-diagram.js";
import { INTERACTIVE_GUIDE } from "./guide-interactive.js";
import { MOCKUP_GUIDE } from "./guide-mockup.js";

/** Module names, in the order they are emitted when several are requested. */
export const VISUALIZE_GUIDE_MODULES = [
  "diagram",
  "interactive",
  "mockup",
  "chart",
] as const;

export type VisualizeGuideModule = (typeof VISUALIZE_GUIDE_MODULES)[number];

/** One-line summaries, used in the tool's input schema and its error text. */
export const MODULE_SUMMARIES: Record<VisualizeGuideModule, string> = {
  diagram:
    "SVG flowcharts, structural diagrams, illustrative mechanism drawings",
  interactive:
    "steppers, tabs, sliders, filters, live calculations in vanilla JS",
  mockup: "cards, records, forms, dashboards, faux screens",
  chart: "hand-drawn SVG bar, line, area, and donut charts",
};

const MODULE_GUIDES: Record<VisualizeGuideModule, string> = {
  diagram: DIAGRAM_GUIDE,
  interactive: INTERACTIVE_GUIDE,
  mockup: MOCKUP_GUIDE,
  chart: CHART_GUIDE,
};

export function isVisualizeGuideModule(
  value: unknown,
): value is VisualizeGuideModule {
  return (
    typeof value === "string" &&
    (VISUALIZE_GUIDE_MODULES as readonly string[]).includes(value)
  );
}

export function getModuleGuide(module: VisualizeGuideModule): string {
  return MODULE_GUIDES[module];
}
