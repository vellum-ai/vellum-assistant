import { makeRuntimeEfficiencyMetric } from "../../../../../src/lib/common-metrics/runtime-efficiency";

/**
 * Building, screenshotting, and demonstrating a working calculator is a
 * multi-step task, so the agent earns full marks for resolving it within ten
 * minutes; slower runs decay from there rather than flooring to zero.
 */
export default makeRuntimeEfficiencyMetric({ baselineMs: 600_000 });
