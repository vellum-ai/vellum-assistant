import * as React from "react";
import { ProgressBar } from "@vellumai/design-library";

export const Default = () => (
  <div style={{ width: 320 }}>
    <ProgressBar value={0.6} aria-label="Progress" />
  </div>
);

export const Empty = () => (
  <div style={{ width: 320 }}>
    <ProgressBar value={0} aria-label="Empty progress" />
  </div>
);

export const Full = () => (
  <div style={{ width: 320 }}>
    <ProgressBar value={1} aria-label="Complete" />
  </div>
);

export const CustomHeight = () => (
  <div style={{ width: 320 }}>
    <ProgressBar value={0.45} height={12} aria-label="Thick progress bar" />
  </div>
);

export const Increments = () => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: "0.75rem",
      width: 320,
    }}
  >
    {[0, 0.25, 0.5, 0.75, 1].map((v) => (
      <ProgressBar key={v} value={v} aria-label={`${v * 100}%`} />
    ))}
  </div>
);
