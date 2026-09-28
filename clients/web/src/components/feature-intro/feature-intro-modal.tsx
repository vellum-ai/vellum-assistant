import type { ReactNode } from "react";

import { cn } from "@vellumai/design-library/utils/cn";
import { Modal } from "@vellumai/design-library/components/modal";

import { useTranslation } from "@/i18n";

export interface FeatureIntroModalProps {
  open: boolean;
  /** Any way out: the close glyph, the backdrop, Escape, or a call to action. */
  onOpenChange: (open: boolean) => void;
  /** The picture over the title; drawn at its own size, centred. */
  hero?: ReactNode;
  title: string;
  description: string;
  /** The pitch under the description: perks, a notice, the calls to action. */
  children?: ReactNode;
  className?: string;
}

/**
 * The frame every one-time feature intro is drawn in: a centred column on
 * the lifted surface, a hero, the feature's name in the brand serif, one
 * line on what it is, and the feature's own pitch under that. The frame
 * knows nothing about when it shows; `useFeatureIntroSeen` and a gate that
 * reads the feature's own state decide that (see
 * `assistant-email-intro.tsx` for the worked example).
 */
export function FeatureIntroModal({
  open,
  onOpenChange,
  hero,
  title,
  description,
  children,
  className,
}: FeatureIntroModalProps) {
  const { t } = useTranslation();
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content
        size="md"
        closeLabel={t("featureIntroModal.close")}
        data-testid="feature-intro-modal"
        className={cn("max-w-[500px] backdrop-blur-[32px]", className)}
      >
        <Modal.Body className="flex flex-col items-center gap-8 px-8 pt-8 pb-8 text-center">
          {hero ? (
            <div className="flex shrink-0 items-center justify-center">
              {hero}
            </div>
          ) : null}
          <div className="flex w-full flex-col items-center gap-4">
            <Modal.Title
              className="w-full justify-center text-center text-[var(--content-emphasised)] [&>span]:whitespace-normal"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "32px",
                fontWeight: 400,
                lineHeight: 1.2,
                letterSpacing: "0.64px",
              }}
            >
              {title}
            </Modal.Title>
            <Modal.Description className="mt-0 max-w-[343px] text-center text-[16px] leading-6 text-[var(--content-default)]">
              {description}
            </Modal.Description>
          </div>
          {children}
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}
