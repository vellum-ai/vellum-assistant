import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { DetailCard } from "@/components/detail-card";
import { SettingsDivider } from "@/domains/settings/components/settings-divider";
import {
    getDeviceBool,
    getDeviceSetting,
    setDeviceBool,
    setDeviceSetting,
} from "@/utils/device-settings";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Toggle } from "@vellumai/design-library/components/toggle";

const DEFAULT_VIDEO_ALLOWLIST: ReadonlyArray<string> = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "loom.com",
];

function parseAllowlist(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fall through
  }
  return [...DEFAULT_VIDEO_ALLOWLIST];
}

function loadEnabled(): boolean {
  return getDeviceBool("mediaEmbedsEnabled", true);
}

function loadAllowlist(): string[] {
  const raw = getDeviceSetting("mediaEmbedDomains", "");
  if (!raw) return [...DEFAULT_VIDEO_ALLOWLIST];
  return parseAllowlist(raw);
}

export function MediaEmbedsCard() {
  const [enabled, setEnabled] = useState<boolean>(() => loadEnabled());
  const [domains, setDomains] = useState<string[]>(() => loadAllowlist());
  const [expanded, setExpanded] = useState(false);
  const [newDomain, setNewDomain] = useState("");

  const trimmedNewDomain = useMemo(
    () => newDomain.trim().toLowerCase(),
    [newDomain],
  );

  const handleToggle = (next: boolean) => {
    setEnabled(next);
    setDeviceBool("mediaEmbedsEnabled", next);
  };

  const persistDomains = (next: string[]) => {
    setDomains(next);
    setDeviceSetting("mediaEmbedDomains", JSON.stringify(next));
  };

  const addDomain = () => {
    if (!trimmedNewDomain) return;
    if (domains.includes(trimmedNewDomain)) {
      setNewDomain("");
      return;
    }
    persistDomains([...domains, trimmedNewDomain]);
    setNewDomain("");
  };

  const removeDomain = (domain: string) => {
    persistDomains(domains.filter((d) => d !== domain));
  };

  const resetDomains = () => {
    persistDomains([...DEFAULT_VIDEO_ALLOWLIST]);
  };

  const isDefaultAllowlist =
    domains.length === DEFAULT_VIDEO_ALLOWLIST.length &&
    domains.every((d, i) => d === DEFAULT_VIDEO_ALLOWLIST[i]);

  return (
    <DetailCard
      title="Media Embeds"
      subtitle="Automatically embed images, videos, and other media shared in chat messages."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-body-medium-lighter text-[var(--content-default)]">
          Auto Media Embeds
        </div>
        <Toggle checked={enabled} onChange={handleToggle} />
      </div>

      {enabled && (
        <>
          <div className="mt-4">
            <SettingsDivider />
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-4 w-full justify-between px-3"
            aria-expanded={expanded}
          >
            <span className="flex items-center gap-2">
              {expanded ? (
                <ChevronDown className="h-4 w-4" aria-hidden />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden />
              )}
              Video Domain Allowlist
            </span>
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              {domains.length} domain{domains.length === 1 ? "" : "s"}
            </span>
          </Button>

          {expanded && (
            <div className="mt-3 space-y-3">
              <div className="flex items-end gap-2">
                <Input
                  label="Add Domain"
                  type="text"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDomain();
                    }
                  }}
                  placeholder="Add domain (e.g. example.com)"
                  fullWidth
                  wrapperClassName="flex-1"
                />
                <Button
                  variant="primary"
                  size="compact"
                  onClick={addDomain}
                  disabled={!trimmedNewDomain}
                >
                  Add
                </Button>
              </div>

              {domains.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={resetDomains}
                    disabled={isDefaultAllowlist}
                    tintColor="var(--content-tertiary)"
                  >
                    Reset to Defaults
                  </Button>
                </div>
              )}

              {domains.length > 0 && (
                <ul className="space-y-2">
                  {domains.map((domain) => (
                    <li
                      key={domain}
                      className="flex items-center justify-between rounded-md border border-[var(--border-base)] px-3 py-2 text-body-medium-lighter"
                    >
                      <span className="font-mono text-[var(--content-default)]">
                        {domain}
                      </span>
                      <Button
                        variant="dangerGhost"
                        size="compact"
                        iconOnly={<Trash2 />}
                        onClick={() => removeDomain(domain)}
                        aria-label={`Remove ${domain}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </DetailCard>
  );
}
