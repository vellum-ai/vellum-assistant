import { useTranslation } from "@/i18n";

/**
 * What the introduction says when the voice key was asked for and never came.
 *
 * The one thing known for certain at this point is that no edge reached the
 * app, so the card says that and names the causes that account for nearly
 * every case: the key remapped at the system level, another app holding it,
 * or Input Monitoring not granted. The Keyboard settings are offered because
 * that is where the remap lives and the one place the app cannot send the
 * user by asking for a permission.
 *
 * **This is the seam for telling the causes apart.** A detection that can name
 * one of them (a remap read off the system, another app seen holding the key)
 * belongs here as a prop that narrows the explanation and the destination,
 * with this generic reading as what remains when nothing more specific is
 * known. The card around it stays as it is: the title, the Skip and the Try
 * again are the same whatever the cause turns out to be.
 */
export interface CompanionIntroHoldHelpProps {
  /** Open macOS's Keyboard settings. Absent leaves the control inert, which
   *  is what Storybook wants. */
  onOpenKeyboardSettings?: () => void;
}

export function CompanionIntroHoldHelp({
  onOpenKeyboardSettings,
}: CompanionIntroHoldHelpProps) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-[12px] leading-[1.45] text-white/70">
        {t("companionIntro.hold.unreachedBody")}
      </p>
      <button
        type="button"
        className="h-7 self-start rounded-full bg-white/10 px-2.5 text-[12px] text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        onClick={onOpenKeyboardSettings}
      >
        {t("companionIntro.hold.openKeyboardSettings")}
      </button>
    </>
  );
}
