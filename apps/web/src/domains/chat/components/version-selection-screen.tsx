
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Dropdown } from "@vellum/design-library";
import { releasesList } from "@/generated/api/sdk.gen";
import type { ReleaseListItem } from "@/generated/api/types.gen";

export interface VersionSelectionScreenProps {
  onHatch: (version?: string) => void;
}

export function VersionSelectionScreen({ onHatch }: VersionSelectionScreenProps) {
  const [releases, setReleases] = useState<ReleaseListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<string>("");

  useEffect(() => {
    releasesList({ query: { stable: true } })
      .then((result) => {
        const items = result.data ?? [];
        setReleases(items);
        setSelectedVersion("");
      })
      .catch(() => {
        setReleases([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-24">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--system-positive-weak)]"
        style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
      >
        {/* typography: off-scale — emoji hero sized via text-3xl */}
        <span className="text-3xl" role="img" aria-label="seedling">
          &#x1F331;
        </span>
      </div>
      <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
        Hatch your assistant
      </h2>
      <p className="mt-3 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
        Select a release version to hatch with.
      </p>
      <div className="mt-6 flex flex-col items-center gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading releases...
          </div>
        ) : (
          <Dropdown
            value={selectedVersion}
            onChange={setSelectedVersion}
            options={[
              { value: "", label: "Latest (default)" },
              ...releases.map((r) => ({
                value: r.version,
                label: `${r.version}${r.is_stable === false ? " (unstable)" : ""}`,
              })),
            ]}
          />
        )}
        <button
          type="button"
          onClick={() => onHatch(selectedVersion || undefined)}
          disabled={loading}
          className="flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-6 py-3 text-body-medium-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
        >
          Hatch Assistant
        </button>
      </div>
    </div>
  );
}
