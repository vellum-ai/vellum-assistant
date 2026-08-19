import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";

import { useTranslation, type TFunction } from "@/i18n";

interface PairDeviceReadyProps {
  pairUrl: string;
  remainingMs: number;
  expired: boolean;
  copied: boolean;
  onCopy: (text: string) => void;
}

/** "Expires in m:ss · single-use.", or a bare "Single-use." once time is up. */
function formatExpiry(t: TFunction<"settings">, remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return t("pairDeviceReady.singleUse");
  }
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return t("pairDeviceReady.expiresIn", {
    time: `${minutes}:${seconds.toString().padStart(2, "0")}`,
  });
}

/**
 * The live-code view: the scannable QR, the pair URL as copyable text, and the
 * expiry countdown — or an expired notice once the single-use code lapses.
 */
export function PairDeviceReady({
  pairUrl,
  remainingMs,
  expired,
  copied,
  onCopy,
}: PairDeviceReadyProps) {
  const { t } = useTranslation("settings");

  if (expired) {
    return (
      <Notice tone="warning" title={t("pairDeviceReady.expiredTitle")}>
        {t("pairDeviceReady.expiredBody")}
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* A white backdrop keeps the QR high-contrast and scannable in every
          theme — the code itself must not vary with the app surface. */}
      <div className="w-fit rounded-lg bg-white p-3">
        <QRCodeSVG
          value={pairUrl}
          size={192}
          // eslint-disable-next-line local/no-untranslated-strings -- QR error-correction level, not copy
          level="M"
          title={t("pairDeviceReady.qrTitle")}
        />
      </div>
      <div className="flex items-center gap-2">
        <code
          data-testid="pair-device-url"
          className="min-w-0 flex-1 truncate rounded-md bg-[var(--surface-active)] px-2.5 py-1.5 text-body-small-default text-[var(--content-secondary)]"
        >
          {pairUrl}
        </code>
        <Button
          variant="outlined"
          size="compact"
          leftIcon={copied ? <Check /> : <Copy />}
          onClick={() => onCopy(pairUrl)}
        >
          {copied
            ? t("pairDeviceReady.copiedButton")
            : t("pairDeviceReady.copyButton")}
        </Button>
      </div>
      <p className="text-body-small-default text-[var(--content-tertiary)]">
        {formatExpiry(t, remainingMs)}
      </p>
    </div>
  );
}
