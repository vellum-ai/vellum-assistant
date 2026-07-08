import { type ReactNode } from "react";

import { CompactionCircuitOpenBanner } from "@/domains/chat/components/compaction-circuit-open-banner";
import { MaintenanceModeBanner } from "@/domains/chat/components/maintenance-mode-banner";
import { MissingApiKeyBanner } from "@/domains/chat/components/missing-api-key-banner";
import {
  formatVoiceError,
  isMicPermissionError,
  isMicPermissionPermanentError,
  isTextInsertionPermissionError,
} from "@/domains/chat/utils/chat";
import { Button, Notice } from "@vellumai/design-library";

/**
 * Orchestration banner stack rendered above the chat composer's form (in
 * `ChatComposer`'s `noticesAboveFormSlot`, below the composer-owned
 * {@link ComposerDraftNotices}). Each banner is fully controlled by the parent
 * — this component only owns composition and ordering. Banners cover voice,
 * disk pressure, billing, setup, and operational state; the composer-owned
 * draft/attachment notices live in {@link ComposerDraftNotices}, which renders
 * ahead of this stack.
 *
 * All props are optional or boolean flags so the component can be used by
 * both the main chat path (full feature set) and the app-editing side
 * panel (which has no voice input).
 */
export interface ComposerNoticesProps {
  /** Live voice-input error code, or `null` when no error is active. */
  voiceError?: string | null;
  /** Dismiss handler for {@link voiceError}. Required when error is non-null. */
  onClearVoiceError?: () => void;
  /** Mic-permission retry handler. Only shown when {@link voiceError} is a permission error. */
  onRetryMicPermission?: () => void;
  /**
   * Opens the OS microphone privacy settings. Only shown when
   * {@link voiceError} is a permanent (OS-recorded) mic-permission denial,
   * which macOS never re-prompts for. Omit when no settings deep-link is
   * available (plain browser).
   */
  onOpenMicSettings?: () => void | Promise<void>;
  /** Opens macOS Automation settings for external-app dictation paste. */
  onOpenTextInsertionSettings?: () => void | Promise<void>;

  /**
   * Pre-rendered disk-pressure banner from the chat page, or `null` when
   * disk pressure is inactive. Passed as a slot because its content is
   * derived from runtime metrics owned by the page.
   */
  diskPressureBanner?: ReactNode | null;

  /**
   * Pre-rendered provider-billing banner, or `null` when no billing
   * banner should be shown. Passed as a slot because billing-banner
   * visibility depends on multiple data sources (plan, usage, provider).
   */
  billingBannerSlot?: ReactNode;

  /** True when the assistant returned `PROVIDER_NOT_CONFIGURED`. */
  showMissingApiKeyBanner: boolean;
  /** Handler invoked when the user clicks "Open settings" on the missing-API-key banner. */
  onOpenAiSettings: () => void;
  /** Handler invoked when the user dismisses the missing-API-key banner. */
  onDismissApiKeyError: () => void;

  /**
   * When non-null and in the future, the compaction circuit is open and a
   * banner is shown counting down to expiration. `null` skips the banner.
   */
  compactionCircuitOpenUntil?: Date | null;
  /** Invoked when the compaction-circuit countdown elapses. */
  onCompactionCircuitExpired?: () => void;

  /** True when the assistant is in maintenance/recovery mode. */
  showMaintenanceBanner: boolean;
  /** True when this composer notice should render its own maintenance exit action. */
  showMaintenanceExitAction?: boolean;
  /** Assistant id used by the maintenance banner's "exited" callback. */
  assistantId?: string | null;
  /** Invoked when the assistant exits maintenance mode. */
  onMaintenanceExited?: () => void;
}

export function ComposerNotices({
  voiceError,
  onClearVoiceError,
  onRetryMicPermission,
  onOpenMicSettings,
  onOpenTextInsertionSettings,
  diskPressureBanner,
  billingBannerSlot,
  showMissingApiKeyBanner,
  onOpenAiSettings,
  onDismissApiKeyError,
  compactionCircuitOpenUntil,
  onCompactionCircuitExpired,
  showMaintenanceBanner,
  showMaintenanceExitAction = true,
  assistantId,
  onMaintenanceExited,
}: ComposerNoticesProps) {
  return (
    <>
      {voiceError && (
        <div className="mb-2">
          <Notice
            tone="error"
            onDismiss={onClearVoiceError}
            actions={
              isMicPermissionError(voiceError) && onRetryMicPermission ? (
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={onRetryMicPermission}
                >
                  Allow Microphone
                </Button>
              ) : isMicPermissionPermanentError(voiceError) &&
                onOpenMicSettings ? (
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => {
                    void onOpenMicSettings();
                  }}
                >
                  Open Settings
                </Button>
              ) : isTextInsertionPermissionError(voiceError) &&
                onOpenTextInsertionSettings ? (
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => {
                    void onOpenTextInsertionSettings();
                  }}
                >
                  Open Settings
                </Button>
              ) : undefined
            }
          >
            {formatVoiceError(voiceError)}
          </Notice>
        </div>
      )}
      {diskPressureBanner ? (
        <div className="mb-2">{diskPressureBanner}</div>
      ) : null}
      {billingBannerSlot}
      {showMissingApiKeyBanner && (
        <div className="mb-2">
          <MissingApiKeyBanner
            onOpenSettings={onOpenAiSettings}
            onDismiss={onDismissApiKeyError}
          />
        </div>
      )}
      {compactionCircuitOpenUntil &&
        compactionCircuitOpenUntil > new Date() &&
        onCompactionCircuitExpired && (
          <div className="mb-2">
            <CompactionCircuitOpenBanner
              openUntil={compactionCircuitOpenUntil}
              onExpired={onCompactionCircuitExpired}
            />
          </div>
        )}
      {showMaintenanceBanner && assistantId && onMaintenanceExited && (
        <div className="mb-2">
          <MaintenanceModeBanner
            assistantId={assistantId}
            onExited={onMaintenanceExited}
            showExitAction={showMaintenanceExitAction}
          />
        </div>
      )}
    </>
  );
}
