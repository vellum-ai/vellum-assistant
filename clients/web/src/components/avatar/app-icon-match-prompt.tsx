/**
 * The one surface that offers to match the iOS home-screen icon to the
 * assistant's avatar.
 *
 * Three paths reach it and none needs code of its own, because all three are
 * the same fact arriving: the avatar query says this assistant is a character
 * the installed build ships an icon for, and that icon is not the one applied.
 * Saving a character in the avatar editor invalidates that query; an avatar
 * changed on another device arrives through the `avatar_updated` sweep, or on
 * the next foreground; and a new user's first arrival in the main app is the
 * query resolving for the first time.
 *
 * Two guards keep it from becoming nagging. A dismissal is remembered per icon
 * name forever, so the answer holds for that avatar but a different avatar is
 * a new question. And a name is offered at most once per app session, so a
 * query refetch or a route change cannot re-ask what is already on screen.
 *
 * Both guards spend the question, so only an answered question spends them. An
 * Apply iOS refuses leaves the home screen untouched, so the dialog stays up
 * with the failure named on it and the name goes back to the session.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { AvatarRenderer } from "@/components/avatar-renderer";
import { useAppIconSync } from "@/hooks/use-app-icon-sync";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import {
  selectTourActive,
  useInChatOnboardingStore,
} from "@/stores/in-chat-onboarding-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { shouldSuppressRootStatusBanner } from "@/utils/status-banner-visibility";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

const DECLINED_KEY_PREFIX = "vellum:appIcon:declined:";

/** Icon names already offered in this app session, whatever the answer was. */
const offeredThisSession = new Set<string>();

function isDeclined(name: string): boolean {
  return getLocalSetting(DECLINED_KEY_PREFIX + name, "") === "1";
}

function decline(name: string): void {
  setLocalSetting(DECLINED_KEY_PREFIX + name, "1");
}

/** Test seam: drops the once-per-session memory. */
export function __resetAppIconOfferSession(): void {
  offeredThisSession.clear();
}

interface AppIconMatchPromptProps {
  assistantId: string | null;
}

export function AppIconMatchPrompt({ assistantId }: AppIconMatchPromptProps) {
  const { t } = useTranslation();
  const { enabled, targetIcon, canOffer, apply } = useAppIconSync(assistantId);
  const { components, traits } = useAssistantAvatar(assistantId);

  // Onboarding owns the whole screen while it runs, and a first-run user has
  // not yet met the avatar this offer is about.
  const location = useLocation();
  const onSetupRoute = shouldSuppressRootStatusBanner(
    location.pathname,
    location.search,
  );
  const focusedOnboarding = useOnboardingFocusStore.use.focused();
  const tourActive = useInChatOnboardingStore(selectTourActive);
  const onboardingActive = onSetupRoute || focusedOnboarding || tourActive;

  const [offer, setOffer] = useState<string | null>(null);
  // Completion handlers read the offer through this ref: a swap can outlive
  // the offer that started it, and only the dialog for the completed name may
  // settle. Synced in an effect, never during render.
  const offerRef = useRef<string | null>(null);
  useEffect(() => {
    offerRef.current = offer;
  }, [offer]);
  const [applyFailed, setApplyFailed] = useState(false);
  const [pending, setPending] = useState(false);

  // An offer is about one icon name, so it only survives while that name is
  // still the answer. Onboarding taking the screen, the avatar becoming one we
  // ship no icon for, or the active assistant changing all retire the question
  // on screen rather than leaving it to act on the new assistant's behalf. A
  // retired question was never answered, so its name goes back to the session
  // and can be asked again later.
  useEffect(() => {
    const retire = () => {
      if (offer !== null) {
        offeredThisSession.delete(offer);
      }
      setOffer(null);
      setApplyFailed(false);
    };
    if (!canOffer || targetIcon === null || onboardingActive) {
      retire();
      return;
    }
    if (offer === targetIcon) {
      return;
    }
    if (offeredThisSession.has(targetIcon) || isDeclined(targetIcon)) {
      retire();
      return;
    }
    offeredThisSession.add(targetIcon);
    setOffer(targetIcon);
    setApplyFailed(false);
  }, [canOffer, targetIcon, onboardingActive, offer]);

  if (!enabled) {
    return null;
  }

  const handleApply = async () => {
    const name = offer;
    if (name === null || pending) {
      return;
    }
    setPending(true);
    setApplyFailed(false);
    try {
      if (await apply()) {
        // An earlier refusal in this same dialog handed the name back to the
        // session, so a landed swap has to take it again.
        offeredThisSession.add(name);
        // A replacement offer can appear while the swap is in flight; only
        // the dialog for the completed name settles.
        if (offerRef.current === name) {
          setOffer(null);
        }
        return;
      }
      // Nothing changed on the home screen, so nothing was answered: give the
      // name back to the session and keep the dialog up to be tried again.
      offeredThisSession.delete(name);
      if (offerRef.current === name) {
        setApplyFailed(true);
      }
    } finally {
      setPending(false);
    }
  };

  const handleDismiss = () => {
    if (offer !== null) {
      decline(offer);
    }
    setOffer(null);
  };

  return (
    <Modal.Root
      open={offer !== null}
      onOpenChange={(next) => {
        if (!next) {
          handleDismiss();
        }
      }}
    >
      <Modal.Content size="sm" hideCloseButton>
        <Modal.Header>
          <Modal.Title>{t("appIconMatchPrompt.title")}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {components && traits ? (
            <div className="mb-3 flex justify-center">
              <div className="rounded-2xl bg-[var(--surface-sunken)] p-4">
                <AvatarRenderer
                  components={components}
                  bodyShapeId={traits.bodyShape}
                  eyeStyleId={traits.eyeStyle}
                  colorId={traits.color}
                  size={96}
                />
              </div>
            </div>
          ) : null}
          <Modal.Description>
            {t("appIconMatchPrompt.message")}
          </Modal.Description>
          {applyFailed ? (
            <p
              role="alert"
              className="mt-3 text-body-small-default text-[color:var(--content-negative)]"
            >
              {t("appIconMatchPrompt.error")}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={handleDismiss}>
            {t("appIconMatchPrompt.notNow")}
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => void handleApply()}
          >
            {t("appIconMatchPrompt.apply")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
