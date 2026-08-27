import { AlertCircle, Check, Clock, Loader2 } from "lucide-react";

import { useTranslation } from "@/i18n";

import type { DomainVerificationStatusStatusEnum } from "@/generated/api/types.gen";

interface DomainVerificationChipProps {
  status: DomainVerificationStatusStatusEnum | undefined;
  isLoading: boolean;
}

export function DomainVerificationChip({
  status,
  isLoading,
}: DomainVerificationChipProps) {
  const { t } = useTranslation("common");

  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2.5 py-0.5 text-body-small-default text-[var(--content-quiet)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("domainVerificationChip.checkingDomain")}
      </span>
    );
  }

  // `unknown` is the API saying it could not retrieve the status; absence is
  // this client not having a response yet. Both render the same chip because
  // neither is a verdict about the domain.
  if (!status || status === "unknown") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2.5 py-0.5 text-body-small-default text-[var(--content-quiet)]"
        title={t("domainVerificationChip.unknownStatusTitle")}
      >
        {t("domainVerificationChip.unknownStatus")}
      </span>
    );
  }

  if (status === "verified") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--system-positive-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-positive-strong)]"
        title={t("domainVerificationChip.verifiedTitle")}
      >
        <Check className="h-3 w-3" />
        {t("domainVerificationChip.domainVerified")}
      </span>
    );
  }

  if (status === "pending" || status === "not_started") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--system-mid-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-mid-strong)]"
        title={t("domainVerificationChip.verifyingTitle")}
      >
        <Clock className="h-3 w-3" />
        {t("domainVerificationChip.verifyingDomain")}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[var(--system-negative-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-negative-strong)]"
      title={t("domainVerificationChip.failedTitle")}
    >
      <AlertCircle className="h-3 w-3" />
      {t("domainVerificationChip.verificationFailed")}
    </span>
  );
}
