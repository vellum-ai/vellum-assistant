
import { Clock } from "lucide-react";
import { useEffect } from "react";

interface CompactionCircuitOpenBannerProps {
  openUntil: Date;
  onExpired: () => void;
}

export function CompactionCircuitOpenBanner({
  openUntil,
  onExpired,
}: CompactionCircuitOpenBannerProps) {
  useEffect(() => {
    // Check immediately in case already expired
    if (Date.now() >= openUntil.getTime()) {
      onExpired();
      return;
    }

    const interval = setInterval(() => {
      if (Date.now() >= openUntil.getTime()) {
        onExpired();
        clearInterval(interval);
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [openUntil, onExpired]);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={{
        // typography: off-scale — banner with custom brand background requires white text
        backgroundColor: "var(--system-mid-strong)",
        color: "#fff",
        borderRadius: "10px 10px 0 0",
      }}
      role="status"
      aria-label="Auto-compaction paused"
      data-testid="compaction-circuit-open-banner"
    >
      <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="text-body-medium-default">
        Auto-compaction paused &mdash; long conversation may overflow. Use /compact to compact
        manually.
      </span>
    </div>
  );
}
