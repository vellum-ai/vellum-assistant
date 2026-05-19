import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createCriticalDiskPressureStatus } from "@/lib/assistants/disk-pressure-test-fixtures.js";

import { DiskPressureBanner } from "@/components/app/assistant/DiskPressureBanner.js";

describe("DiskPressureBanner", () => {
  test("renders the guarded acknowledgement banner", () => {
    const html = renderToStaticMarkup(
      <DiskPressureBanner
        status={createCriticalDiskPressureStatus({ usagePercent: 93 })}
        mode="acknowledgement-required"
        isAcknowledging={false}
        acknowledgeError={null}
        onAcknowledge={() => {}}
        onReviewDiskUsage={() => {}}
      />,
    );

    expect(html).toContain("Storage is critically low");
    expect(html).toContain("Current usage: 93%");
    expect(html).toContain(
      "Background processes and trusted-contact messages are blocked",
    );
    expect(html).toContain(
      "Acknowledge to continue with cleanup tools.",
    );
    expect(html).toContain("Acknowledge and clean up");
    expect(html).toContain("Review storage");
    expect(html).not.toContain("Dismiss");
  });

  test("renders acknowledgement progress and errors", () => {
    const html = renderToStaticMarkup(
      <DiskPressureBanner
        status={createCriticalDiskPressureStatus({ usagePercent: 93 })}
        mode="acknowledgement-required"
        isAcknowledging
        acknowledgeError="Could not acknowledge cleanup mode."
        onAcknowledge={() => {}}
        onReviewDiskUsage={() => {}}
      />,
    );

    expect(html).toContain("Acknowledging...");
    expect(html).toContain("disabled=");
    expect(html).toContain("Could not acknowledge cleanup mode.");
  });

  test("renders persistent cleanup mode status", () => {
    const html = renderToStaticMarkup(
      <DiskPressureBanner
        status={createCriticalDiskPressureStatus({
          acknowledged: true,
          usagePercent: 93,
        })}
        mode="cleanup"
        onAcknowledge={() => {}}
        onReviewDiskUsage={() => {}}
      />,
    );

    expect(html).toContain("Cleanup mode is active");
    expect(html).toContain(
      "Background processes and trusted-contact messages remain blocked",
    );
    expect(html).toContain(
      "until storage is freed.",
    );
    expect(html).toContain("Review storage");
    expect(html).not.toContain("Acknowledge and clean up");
    expect(html).not.toContain("Dismiss");
  });
});
