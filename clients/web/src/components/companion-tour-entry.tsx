import {
  ArrowRight,
  MessageCircle,
  MonitorUp,
  MousePointer2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button, Modal } from "@vellumai/design-library";
import {
  DEFAULT_COMPANION_SIZE,
  companionBoxFor,
} from "@vellumai/ipc-contract";

import { CompanionSurface } from "@/components/companion-surface";
import { useTranslation } from "@/i18n";

const AVATAR_BOX = companionBoxFor("avatar", DEFAULT_COMPANION_SIZE);
const OPTIONS_BOX = companionBoxFor("options", DEFAULT_COMPANION_SIZE);

export interface CompanionTourEntryModalProps {
  open: boolean;
  onStart: () => void;
  onDismiss: () => void;
}

export function CompanionTourEntryModal({
  open,
  onStart,
  onDismiss,
}: CompanionTourEntryModalProps): ReactNode {
  const { t } = useTranslation();
  const [confirmingDismissal, setConfirmingDismissal] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setConfirmingDismissal(false);
    }
  }, [open]);

  const startTour = (): void => {
    setConfirmingDismissal(false);
    onStart();
  };

  const dismissTour = (): void => {
    setConfirmingDismissal(false);
    onDismiss();
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setConfirmingDismissal(true);
        }
      }}
    >
      <Modal.Content
        ref={contentRef}
        size="lg"
        hideCloseButton
        dismissOnOverlayClick={false}
        // **The card takes the opening focus, not the first control in it.**
        // Radix focuses the first tabbable node on open, and this card draws
        // its own close button above the copy, so that node is the one control
        // that throws the tour away. Nobody asked for this dialog: it opens by
        // itself when the surface first appears, so the ring lands on the exit
        // before the user has touched anything, and reads as a pointer already
        // resting on the X. Focusing the card keeps the trap and Escape intact
        // while leaving the ring off a control the user never aimed at; the
        // first Tab still reaches the close button.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setConfirmingDismissal(true);
        }}
        className="max-w-[820px] overflow-hidden"
      >
        <div className="relative grid min-h-[500px] md:grid-cols-[1.18fr_0.82fr]">
          {!confirmingDismissal ? (
            <button
              type="button"
              aria-label={t("companionIntro.announcement.close")}
              className="absolute top-4 right-4 z-10 flex size-8 items-center justify-center rounded-full text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)] md:text-white/60 md:hover:bg-white/10 md:hover:text-white"
              onClick={() => setConfirmingDismissal(true)}
            >
              <X className="size-4" />
            </button>
          ) : null}

          <div className="relative flex min-w-0 flex-col p-8 sm:p-10">
            {confirmingDismissal ? (
              <>
                <div className="flex flex-1 flex-col justify-center">
                  <Modal.Title className="[&>span]:whitespace-normal text-[32px] leading-[1.08] tracking-[0.01em]">
                    {t("companionIntro.announcement.confirm.title")}
                  </Modal.Title>
                  <Modal.Description className="mt-4 max-w-[390px] text-body-medium-lighter leading-6 text-[var(--content-secondary)]">
                    {t("companionIntro.announcement.confirm.body")}
                  </Modal.Description>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 pt-8">
                  <Button variant="ghost" onClick={dismissTour}>
                    {t("companionIntro.announcement.confirm.skip")}
                  </Button>
                  <Button
                    variant="primary"
                    rightIcon={<ArrowRight className="size-4" />}
                    onClick={startTour}
                  >
                    {t("companionIntro.announcement.confirm.keep")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Modal.Title className="[&>span]:whitespace-normal pr-8 text-[32px] leading-[1.08] tracking-[0.01em]">
                  {t("companionIntro.announcement.title")}
                </Modal.Title>
                <Modal.Description className="mt-3 max-w-[420px] text-body-medium-lighter leading-6 text-[var(--content-secondary)]">
                  {t("companionIntro.announcement.body")}
                </Modal.Description>

                <div className="mt-6 flex flex-col gap-2">
                  <TourValueCard
                    icon={MessageCircle}
                    title={t("companionIntro.announcement.cards.flow.title")}
                    body={t("companionIntro.announcement.cards.flow.body")}
                  />
                  <TourValueCard
                    icon={MonitorUp}
                    title={t("companionIntro.announcement.cards.context.title")}
                    body={t("companionIntro.announcement.cards.context.body")}
                  />
                  <TourValueCard
                    icon={MousePointer2}
                    title={t(
                      "companionIntro.announcement.cards.together.title",
                    )}
                    body={t("companionIntro.announcement.cards.together.body")}
                  />
                </div>

                <div className="mt-auto flex justify-end pt-8">
                  <Button
                    variant="primary"
                    rightIcon={<ArrowRight className="size-4" />}
                    onClick={startTour}
                  >
                    {t("companionIntro.announcement.start")}
                  </Button>
                </div>
              </>
            )}
          </div>

          <div
            className="relative hidden min-h-[500px] overflow-hidden bg-[#17191d] md:block"
            aria-label={t("companionIntro.announcement.previewLabel")}
          >
            <div
              className="absolute inset-0 opacity-80"
              style={{
                background:
                  "radial-gradient(circle at 68% 22%, rgba(94,234,212,.2), transparent 34%), linear-gradient(145deg, #252a32 0%, #15171b 72%)",
              }}
            />
            <div className="absolute top-10 right-8 left-8 h-60 overflow-hidden rounded-xl border border-white/10 bg-white/8 shadow-2xl shadow-black/30">
              <div className="flex h-8 items-center gap-1.5 border-b border-white/8 px-3">
                <span className="size-2 rounded-full bg-white/20" />
                <span className="size-2 rounded-full bg-white/15" />
                <span className="size-2 rounded-full bg-white/10" />
              </div>
              <div className="flex flex-col gap-3 p-5">
                <span className="h-2.5 w-2/3 rounded-full bg-white/13" />
                <span className="h-2.5 w-full rounded-full bg-white/8" />
                <span className="h-2.5 w-5/6 rounded-full bg-white/8" />
                <span className="mt-3 h-20 rounded-lg bg-white/6" />
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-48">
              <CompanionSurface
                phase="hover"
                hovered
                spotlight="talk"
                assistantName={t(
                  "companionIntro.announcement.previewAssistantName",
                )}
                accentHex="#5eead4"
                character={{
                  bodyShape: "burst",
                  eyeStyle: "curious",
                  color: "teal",
                }}
                avatarBox={AVATAR_BOX}
                optionsBox={OPTIONS_BOX}
              />
            </div>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

function TourValueCard({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--feed-digest-weak)] text-[var(--feed-digest-strong)]">
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-body-medium-default text-[var(--content-emphasised)]">
          {title}
        </span>
        <span className="text-body-small-default leading-5 text-[var(--content-tertiary)]">
          {body}
        </span>
      </span>
    </div>
  );
}
