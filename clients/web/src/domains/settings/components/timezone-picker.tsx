import { useEffect, useMemo, useRef, useState } from "react";

import { SettingsDivider } from "@/domains/settings/components/settings-divider";
import { Input } from "@vellumai/design-library/components/input";

interface TimezoneEntry {
  identifier: string;
  city: string;
  region: string;
  offsetLabel: string;
  offsetMinutes: number;
}

const FALLBACK_TIMEZONES = [
  "UTC",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Africa/Nairobi",
  "America/Anchorage",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
  "America/Chicago",
  "America/Denver",
  "America/Halifax",
  "America/Lima",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/New_York",
  "America/Phoenix",
  "America/Santiago",
  "America/Sao_Paulo",
  "America/Toronto",
  "America/Vancouver",
  "Asia/Bangkok",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Jakarta",
  "Asia/Jerusalem",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kuala_Lumpur",
  "Asia/Manila",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Australia/Melbourne",
  "Australia/Perth",
  "Australia/Sydney",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Europe/Berlin",
  "Europe/Brussels",
  "Europe/Dublin",
  "Europe/Istanbul",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Moscow",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Vienna",
  "Europe/Warsaw",
  "Europe/Zurich",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

function buildKnownTimezones(): string[] {
  const intlWithValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  if (typeof intlWithValues.supportedValuesOf === "function") {
    try {
      const values = intlWithValues.supportedValuesOf("timeZone");
      if (values.length > 0) {
        return [...values].sort();
      }
    } catch {
      // fall through
    }
  }
  return [...FALLBACK_TIMEZONES].sort();
}

function buildMetadata(identifier: string): TimezoneEntry | null {
  const parts = identifier.split("/");
  const city = (parts[parts.length - 1] ?? identifier).replace(/_/g, " ");
  const region = parts.length > 1 ? (parts[0] ?? "").replace(/_/g, " ") : "";

  let offsetMinutes = 0;
  let offsetLabel = "";
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: identifier,
      timeZoneName: "shortOffset",
    });
    const tzParts = formatter.formatToParts(new Date());
    const tz =
      tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    offsetLabel =
      tz.startsWith("GMT") || tz.startsWith("UTC") ? tz : `GMT ${tz}`;
    const match = tz.match(/([+-])(\d{1,2})(?::(\d{2}))?/);
    if (match) {
      const sign = match[1] === "-" ? -1 : 1;
      const hours = parseInt(match[2] ?? "0", 10);
      const minutes = parseInt(match[3] ?? "0", 10);
      offsetMinutes = sign * (hours * 60 + minutes);
    }
  } catch {
    return null;
  }

  return { identifier, city, region, offsetLabel, offsetMinutes };
}

function formatCurrentTime(identifier: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: identifier,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date());
  } catch {
    return "";
  }
}

function getDisplayName(identifier: string): string {
  if (!identifier) {
    return "Not set";
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: identifier,
      timeZoneName: "long",
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) {
      return name;
    }
  } catch {
    // fall through
  }
  return identifier.replace(/_/g, " ");
}

export interface TimezonePickerProps {
  value: string;
  onChange: (value: string) => void;
}

export function TimezonePicker({ value, onChange }: TimezonePickerProps) {
  const [searchText, setSearchText] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const allEntries = useMemo(() => {
    const ids = buildKnownTimezones();
    return ids
      .map((id) => buildMetadata(id))
      .filter((entry): entry is TimezoneEntry => entry !== null);
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedQuery(searchText.trim().toLowerCase());
    }, 200);
    return () => window.clearTimeout(handle);
  }, [searchText]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isOpen]);

  const filtered = useMemo(() => {
    if (!debouncedQuery) {
      return allEntries;
    }
    return allEntries.filter((entry) => {
      return (
        entry.city.toLowerCase().includes(debouncedQuery) ||
        entry.region.toLowerCase().includes(debouncedQuery) ||
        entry.offsetLabel.toLowerCase().includes(debouncedQuery) ||
        entry.identifier.toLowerCase().includes(debouncedQuery)
      );
    });
  }, [allEntries, debouncedQuery]);

  const selectedCity = useMemo(() => {
    if (!value) {
      return "";
    }
    const parts = value.split("/");
    return (parts[parts.length - 1] ?? value).replace(/_/g, " ");
  }, [value]);

  const handleSelect = (identifier: string) => {
    onChange(identifier);
    setSearchText("");
    setIsOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-4">
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Closest city
        </span>
        <div className="relative w-full md:max-w-[280px]">
          <Input
            ref={inputRef}
            type="text"
            value={searchText}
            placeholder={selectedCity || "Search city or country..."}
            onChange={(event) => {
              setSearchText(event.target.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchText("");
                setIsOpen(false);
                inputRef.current?.blur();
              }
            }}
            fullWidth
          />
          {isOpen && filtered.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[240px] overflow-y-auto rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-lg">
              {filtered.slice(0, 200).map((entry) => {
                const isSelected = entry.identifier === value;
                return (
                  <button
                    key={entry.identifier}
                    type="button"
                    onClick={() => handleSelect(entry.identifier)}
                    className={`flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left text-body-medium-lighter transition-colors ${
                      isSelected
                        ? "bg-[var(--surface-active)] text-[var(--content-default)]"
                        : "text-[var(--content-default)] hover:bg-[var(--surface-active)]"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body-medium-default">
                        {entry.city}
                      </div>
                      {entry.region && (
                        <div className="truncate text-body-small-default text-[var(--content-tertiary)]">
                          {entry.region}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5 text-body-small-default text-[var(--content-tertiary)]">
                      <span>{formatCurrentTime(entry.identifier)}</span>
                      <span>{entry.offsetLabel}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <SettingsDivider />

      <div className="flex items-center justify-between gap-4">
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          Time zone
        </span>
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {getDisplayName(value)}
        </span>
      </div>
    </div>
  );
}
