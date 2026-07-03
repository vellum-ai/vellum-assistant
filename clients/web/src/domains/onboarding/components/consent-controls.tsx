import type { CSSProperties } from "react";

import { SettingRow } from "@/components/setting-row";
import { legalUrl, routes } from "@/utils/routes";
import { Card } from "@vellumai/design-library/components/card";
import { Checkbox } from "@vellumai/design-library/components/checkbox";

/**
 * Consent controls shared by the onboarding privacy screen and the
 * review-terms screen so both surfaces present the toggles and legal
 * agreements identically.
 *
 * - `PrivacyPreferencesCard` — the Share Analytics / Share Diagnostics toggles.
 * - `AgreementsCard`         — the legal consent checkboxes.
 */

// Consent checkboxes mirror the primary button: the checked fill uses
// --primary-base and the check uses --content-inset (the on-primary
// foreground). Unchecked, the design-library default bg/border both resolve to
// the Card surface and disappear, so a recessed fill + visible border keep the
// box legible against the card.
const CONSENT_CHECKBOX_CLASS = [
  "[&_button[data-state=checked]]:bg-[var(--primary-base)]",
  "[&_svg]:text-[var(--content-inset)]",
  "[&_button[data-state=unchecked]]:bg-[var(--surface-base)]",
  "[&_button[data-state=unchecked]]:border-[var(--border-element)]",
].join(" ");

const SECTION_LABEL_CLASS =
  "mb-2.5 ml-1 text-body-small-default font-medium uppercase tracking-wider text-[var(--content-tertiary)]";

const CONSENT_LINKS = {
  privacy: {
    href: routes.docs.legal.privacyPolicy,
    text: "Privacy and AI Data Sharing Policy",
    aria: "I agree to the Privacy and AI Data Sharing Policy",
  },
  tos: {
    href: routes.docs.legal.termsOfUse,
    text: "Terms of Service",
    aria: "I agree to the Terms of Service",
  },
} as const;

function ConsentCheckbox({
  kind,
  checked,
  onChange,
}: {
  kind: keyof typeof CONSENT_LINKS;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const link = CONSENT_LINKS[kind];
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(next) => onChange(next === true)}
      label={
        <span className="text-body-medium-lighter text-[var(--content-default)]">
          I agree to the{" "}
          <a
            href={legalUrl(link.href)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {link.text}
          </a>
        </span>
      }
      aria-label={link.aria}
      className={CONSENT_CHECKBOX_CLASS}
    />
  );
}

function Divider() {
  return <div className="h-px bg-[var(--surface-active)] dark:bg-[var(--surface-lift)]" />;
}

// A short "what's changed" summary shown above a consent checkbox when the
// policy version was bumped. A recessed, left-ruled callout that promotes the
// change itself to the most legible line in the card — it's why the user is
// here. Renders nothing when there are no notes.
function PolicyChangeNotes({ notes }: { notes?: string[] }) {
  if (!notes || notes.length === 0) return null;
  return (
    <div className="rounded-r-md border-l-2 border-[var(--content-secondary)] bg-[var(--surface-base)] py-3 pl-3.5 pr-3.5">
      <p className="text-body-small-default font-medium text-[var(--content-secondary)]">
        What&apos;s changed
      </p>
      {notes.length === 1 ? (
        <p className="mt-1.5 text-body-medium-lighter text-[var(--content-default)]">
          {notes[0]}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {notes.map((note) => (
            <li
              key={note}
              className="flex gap-2.5 text-body-medium-lighter text-[var(--content-default)]"
            >
              <span
                aria-hidden
                className="mt-[0.5em] h-1 w-1 flex-none rounded-full bg-[var(--content-tertiary)]"
              />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PrivacyPreferencesCard({
  electron,
  showAnalytics = true,
  showDiagnostics = true,
  shareAnalytics,
  shareDiagnostics,
  onShareAnalyticsChange,
  onShareDiagnosticsChange,
  className,
  style,
}: {
  electron: boolean;
  showAnalytics?: boolean;
  showDiagnostics?: boolean;
  shareAnalytics: boolean;
  shareDiagnostics: boolean;
  onShareAnalyticsChange: (next: boolean) => void;
  onShareDiagnosticsChange: (next: boolean) => void;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={className} style={style}>
      <p className={SECTION_LABEL_CLASS}>Privacy preferences</p>
      <Card padding={electron ? "sm" : "md"} className="w-full">
        <div className={`flex flex-col ${electron ? "gap-3" : "gap-4"}`}>
          {showAnalytics && (
            <SettingRow
              label="Share Analytics"
              helperText="Send aggregated product usage data"
              checked={shareAnalytics}
              onChange={onShareAnalyticsChange}
            />
          )}
          {showAnalytics && showDiagnostics && <Divider />}
          {showDiagnostics && (
            <SettingRow
              label="Share Diagnostics"
              helperText="Send crash reports, conversation traces, and session replay data"
              checked={shareDiagnostics}
              onChange={onShareDiagnosticsChange}
            />
          )}
        </div>
      </Card>
    </section>
  );
}

export function AgreementsCard({
  electron,
  showPrivacy = true,
  showTos = true,
  privacyConsent,
  tosAccepted,
  onPrivacyChange,
  onTosChange,
  privacyNotes,
  tosNotes,
  className,
  style,
}: {
  electron: boolean;
  showPrivacy?: boolean;
  showTos?: boolean;
  privacyConsent: boolean;
  tosAccepted: boolean;
  onPrivacyChange: (next: boolean) => void;
  onTosChange: (next: boolean) => void;
  privacyNotes?: string[];
  tosNotes?: string[];
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={className} style={style}>
      <p className={SECTION_LABEL_CLASS}>Agreements</p>
      <Card padding={electron ? "sm" : "md"} className="w-full">
        <div className={`flex flex-col ${electron ? "gap-3.5" : "gap-4"}`}>
          {showPrivacy && (
            <div className="flex flex-col gap-2">
              <PolicyChangeNotes notes={privacyNotes} />
              <ConsentCheckbox
                kind="privacy"
                checked={privacyConsent}
                onChange={onPrivacyChange}
              />
            </div>
          )}
          {showTos && (
            <div className="flex flex-col gap-2">
              <PolicyChangeNotes notes={tosNotes} />
              <ConsentCheckbox
                kind="tos"
                checked={tosAccepted}
                onChange={onTosChange}
              />
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
