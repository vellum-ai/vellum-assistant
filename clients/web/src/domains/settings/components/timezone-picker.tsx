import { useMemo, useState } from "react";

import { SettingsDivider } from "@/domains/settings/components/settings-divider";
import { useTranslation } from "@/i18n";
import { cn } from "@vellumai/design-library";
import { Combobox } from "@vellumai/design-library/components/combobox";

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
    const tz = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
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

function getDisplayName(identifier: string, notSetLabel: string): string {
  if (!identifier) {
    return notSetLabel;
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

/**
 * Cap on the rows the list renders at once. The unfiltered catalog runs to a
 * few hundred zones, and typing narrows it long before the cap matters.
 */
const MAX_VISIBLE = 200;

export function TimezonePicker({ value, onChange }: TimezonePickerProps) {
  const { t } = useTranslation("settings");
  const [searchText, setSearchText] = useState("");

  const allEntries = useMemo(() => {
    const ids = buildKnownTimezones();
    return ids
      .map((id) => buildMetadata(id))
      .filter((entry): entry is TimezoneEntry => entry !== null);
  }, []);

  // Filtered straight off the text in the field, with no debounce in between.
  // A debounce here would let the keyboard walk and commit rows belonging to
  // a query the field no longer shows: Enter is only safe while the options
  // are the ones the typing produced. Filtering a few hundred strings is not
  // the expensive part (see `entriesWithTime`), so there is nothing to defer.
  const query = searchText.trim().toLowerCase();
  const visible = useMemo(() => {
    const matching = !query
      ? allEntries
      : allEntries.filter((entry) => {
          return (
            entry.city.toLowerCase().includes(query) ||
            entry.region.toLowerCase().includes(query) ||
            entry.offsetLabel.toLowerCase().includes(query) ||
            entry.identifier.toLowerCase().includes(query)
          );
        });
    return matching.slice(0, MAX_VISIBLE);
  }, [allEntries, query]);

  // What the arrow keys walk: the identifiers of the rows actually rendered.
  const visibleIds = useMemo(
    () => visible.map((entry) => entry.identifier),
    [visible],
  );

  const selectedCity = useMemo(() => {
    if (!value) {
      return "";
    }
    const parts = value.split("/");
    return (parts[parts.length - 1] ?? value).replace(/_/g, " ");
  }, [value]);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-4">
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("timezonePicker.closestCity")}
        </span>
        <Combobox.Root
          className="w-full md:max-w-[280px]"
          options={visibleIds}
          value={value}
          onSelect={onChange}
          onOpenChange={(open) => {
            if (!open) {
              setSearchText("");
            }
          }}
          // A query narrows the list to what the typing meant, so Enter
          // commits the top match; with no query it must pick nothing.
          autoActivateFirst={query.length > 0}
        >
          <Combobox.Input
            type="text"
            aria-label={t("timezonePicker.closestCity")}
            value={searchText}
            placeholder={
              selectedCity || t("timezonePicker.searchPlaceholder")
            }
            onChange={(event) => setSearchText(event.target.value)}
            fullWidth
          />
          <Combobox.List
            aria-label={t("timezonePicker.citiesAriaLabel")}
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[240px] rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-lg"
            emptyState={
              <p className="px-3 py-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                {t("timezonePicker.noMatchingCities")}
              </p>
            }
          >
            {visible.map((entry) => (
              <Combobox.Option
                key={entry.identifier}
                value={entry.identifier}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2",
                  "text-body-medium-lighter text-[var(--content-default)] transition-colors",
                  "hover:bg-[var(--surface-active)]",
                  "data-[active]:bg-[var(--surface-active)] aria-selected:bg-[var(--surface-active)]",
                )}
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
              </Combobox.Option>
            ))}
          </Combobox.List>
        </Combobox.Root>
      </div>

      <SettingsDivider />

      <div className="flex items-center justify-between gap-4">
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("timezonePicker.timeZone")}
        </span>
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          {getDisplayName(value, t("timezonePicker.notSet"))}
        </span>
      </div>
    </div>
  );
}
