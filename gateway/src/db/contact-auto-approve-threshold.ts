/**
 * Per-contact auto-approve ceiling stored on gateway `contacts`.
 *
 * Same vocabulary as the owner globals and channel-permission matrix
 * (`RiskThreshold`: none | low | medium | high). Null means unset.
 */

import {
  isRiskThreshold,
  type RiskThreshold,
} from "@vellumai/gateway-client";

export function parseContactAutoApproveThreshold(
  value: string | null | undefined,
): RiskThreshold | null {
  if (value == null) {
    return null;
  }
  return isRiskThreshold(value) ? value : null;
}
