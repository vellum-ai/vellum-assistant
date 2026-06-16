import { makeRuntimeEfficiencyMetric } from "../../../../../src/lib/common-metrics/runtime-efficiency";

/**
 * A single P&L question is one quick round-trip, so the agent should resolve it
 * inside a minute to earn full marks; slower runs decay from there.
 */
export default makeRuntimeEfficiencyMetric({ baselineMs: 60_000 });
