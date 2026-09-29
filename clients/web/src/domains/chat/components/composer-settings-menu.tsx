import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MouseEventHandler,
} from "react";
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Camera,
  Check,
  File,
  Image,
  LoaderCircle,
  Paperclip,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import {
  BottomSheet,
  Button,
  Collapsible,
  Popover,
  SegmentControl,
  ShortcutKeys,
  acceleratorToAriaKeyShortcuts,
} from "@vellumai/design-library";

import {
  isDispatchableProfile,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import type { useComposerAttachmentPickers } from "@/domains/chat/components/chat-composer/use-composer-attachment-pickers";
import { type ComposerConfiguration } from "@/domains/chat/hooks/use-composer-configuration";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_COPY,
  isBuiltinMode,
  modeHint,
  modeLabel,
  type Autonomy,
} from "@/domains/chat/utils/composer-configuration";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useTranslation } from "@/i18n";
import { presetFromThreshold } from "@/utils/threshold-presets";

import "./composer-settings-menu.css";

const ATTACH_SHORTCUT = "CmdOrCtrl+U";

function AutonomyIcon({ value }: { value: Autonomy | null }) {
  const Icon = value ? presetFromThreshold(value).icon : LoaderCircle;
  return (
    <Icon
      aria-hidden
      className={`size-4 shrink-0${value ? "" : " animate-spin motion-reduce:animate-none"}`}
    />
  );
}

function AutonomyDescription({ value }: { value: Autonomy | null }) {
  const { t } = useTranslation("chat");
  return (
    <>
      {value
        ? t(AUTONOMY_COPY[value].hint)
        : t("composerConfiguration.loading")}
    </>
  );
}

function modelHintTone(entry: ProfilePickerEntry | undefined) {
  return entry &&
    isBuiltinMode(entry) &&
    ["quality-optimized", "cost-optimized"].includes(entry.name)
    ? "warning"
    : undefined;
}

export function ComposerConfigurationContent({
  configuration,
  attachments,
  mobile,
}: {
  configuration: ComposerConfiguration;
  attachments: ReactNode;
  mobile: boolean;
}) {
  const { t } = useTranslation("chat");
  const [view, setView] = useState<"collapsed" | "autonomy" | "model" | "all">(
    "collapsed",
  );
  const [listHeight, setListHeight] = useState<number>();
  const contentRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const favorites = configuration.favorites;
  const active = configuration.profiles.find(
    (entry) => entry.name === configuration.mode,
  );
  const autonomyLabel = configuration.autonomy
    ? t(AUTONOMY_COPY[configuration.autonomy].label)
    : t("composerConfiguration.loading");
  const available = (entry: ProfilePickerEntry) =>
    configuration.modeReady &&
    isDispatchableProfile(entry, configuration.allProfiles, {
      requireOwnProviderAndModel: configuration.requireOwnProviderAndModel,
    });
  const back = () => {
    setView("model");
    requestAnimationFrame(() => moreRef.current?.focus());
  };
  const showAll = () => {
    setListHeight(contentRef.current?.getBoundingClientRect().height);
    setView("all");
  };
  const selectMode = (name: string) => {
    void configuration.selectMode(name);
    if (view === "all") {
      back();
    }
  };
  useEffect(() => {
    if (view === "all") {
      backRef.current?.focus();
    }
  }, [view]);
  const moreButton = (
    <Button
      ref={moreRef}
      variant="ghost"
      className="composer-config-link composer-config-more"
      rightIcon={<ChevronRight aria-hidden className="size-3.5" />}
      onClick={showAll}
    >
      {t(
        mobile
          ? "composerConfiguration.more"
          : "composerConfiguration.allModelsLink",
        {
          count: mobile
            ? Math.max(0, configuration.profiles.length - favorites.length)
            : configuration.profiles.length,
        },
      )}
    </Button>
  );
  return (
    <div
      ref={contentRef}
      className="composer-config"
      data-mobile={mobile || undefined}
      data-view={view}
      style={mobile && view === "all" ? { height: listHeight } : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (view === "all") {
            back();
          } else {
            configuration.setOpen(false);
          }
        }
      }}
    >
      {view === "all" ? (
        <>
          <div className="composer-config-list-header">
            <Button
              ref={backRef}
              variant="ghost"
              className="composer-config-link"
              leftIcon={<ChevronLeft aria-hidden className="size-4" />}
              onClick={back}
            >
              {t("composerConfiguration.back")}
            </Button>
            <span className="composer-config-list-title">
              {t("composerConfiguration.allModes", {
                count: configuration.profiles.length,
              })}
            </span>
            <Button
              variant="ghost"
              className="composer-config-link"
              leftIcon={<Plus aria-hidden className="size-3.5" />}
              onClick={configuration.newMode}
              disabled={!configuration.modeReady}
            >
              {t("composerConfiguration.newMode")}
            </Button>
          </div>
          <div
            className="composer-config-list"
            tabIndex={0}
            role="region"
            aria-label={t("composerConfiguration.allModelsList")}
          >
            {([true, false] as const).map((builtin) => {
              const entries = configuration.profiles.filter(
                (entry) => isBuiltinMode(entry) === builtin,
              );
              if (!entries.length) {
                return null;
              }
              return (
                <section
                  key={String(builtin)}
                  aria-label={t(
                    builtin
                      ? "composerConfiguration.builtIn"
                      : "composerConfiguration.yours",
                  )}
                >
                  <div className="composer-config-list-section">
                    {t(
                      builtin
                        ? "composerConfiguration.builtIn"
                        : "composerConfiguration.yours",
                    )}
                  </div>
                  {entries.map((entry) => (
                    <Button
                      key={entry.name}
                      variant="ghost"
                      className="composer-config-model-row"
                      disabled={!available(entry)}
                      onClick={() => selectMode(entry.name)}
                      aria-pressed={configuration.mode === entry.name}
                      data-selected={
                        configuration.mode === entry.name || undefined
                      }
                    >
                      <span className="min-w-0 flex-1">
                        <span className="composer-config-model-name">
                          {modeLabel(entry)}
                          {isBuiltinMode(entry) && entry.name === "os-beta" && (
                            <span className="composer-config-beta">
                              {t("composerConfiguration.beta")}
                            </span>
                          )}
                        </span>
                        <span
                          className="composer-config-model-description"
                          data-tone={modelHintTone(entry)}
                        >
                          {modeHint(entry)}
                        </span>
                      </span>
                      <span className="size-[18px] shrink-0">
                        {configuration.mode === entry.name && (
                          <Check
                            aria-hidden
                            className="composer-config-check size-[18px]"
                          />
                        )}
                      </span>
                    </Button>
                  ))}
                </section>
              );
            })}
            {!configuration.profiles.length && (
              <p className="composer-config-hint">
                {t("composerConfiguration.noModes")}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {attachments}
          <div className="composer-config-divider" />
          <Collapsible.Root
            type="single"
            collapsible
            value={view === "collapsed" ? "" : view}
            onValueChange={(value) =>
              setView(
                value === "autonomy" || value === "model" ? value : "collapsed",
              )
            }
            className="composer-config-groups"
          >
            <Collapsible.Item
              value="autonomy"
              className="composer-config-group"
            >
              <Collapsible.Trigger
                className="composer-config-summary"
                aria-label={t("composerConfiguration.autonomyTitle")}
              >
                <span className="composer-config-icon">
                  <AutonomyIcon value={configuration.autonomy} />
                </span>
                <span className="composer-config-summary-text">
                  <span className="composer-config-summary-title">
                    {t("composerConfiguration.autonomyTitle")}
                    <span className="composer-config-summary-suffix">
                      {" "}
                      · {autonomyLabel}
                    </span>
                  </span>
                  {view !== "autonomy" && (
                    <span
                      className="composer-config-summary-hint"
                      data-tone={
                        configuration.autonomy === "high" ? "danger" : undefined
                      }
                    >
                      <AutonomyDescription value={configuration.autonomy} />
                    </span>
                  )}
                </span>
                <ChevronDown aria-hidden className="composer-config-chevron" />
              </Collapsible.Trigger>
              <Collapsible.Content>
                <div className="composer-config-expanded">
                  <SegmentControl
                    ariaLabel={t("composerConfiguration.autonomyTitle")}
                    className={`composer-config-segments${mobile ? " composer-config-autonomy-mobile" : ""}`}
                    items={AUTONOMY_LEVELS.map((level) => ({
                      value: level,
                      label: t(AUTONOMY_COPY[level].label),
                      icon: mobile ? <AutonomyIcon value={level} /> : undefined,
                      disabled: !configuration.autonomyReady,
                    }))}
                    value={configuration.autonomy}
                    onChange={(value) =>
                      void configuration.selectAutonomy(value)
                    }
                  />
                  <p
                    className="composer-config-hint"
                    data-tone={
                      configuration.autonomy === "high" ? "danger" : undefined
                    }
                    aria-live="polite"
                  >
                    <AutonomyDescription value={configuration.autonomy} />
                  </p>
                </div>
              </Collapsible.Content>
            </Collapsible.Item>
            <Collapsible.Item value="model" className="composer-config-group">
              <div className="composer-config-model-header">
                <Collapsible.Trigger
                  className="composer-config-summary"
                  aria-label={t("composerConfiguration.modeTitle")}
                >
                  <span className="composer-config-icon">
                    <Sparkles aria-hidden className="size-[18px]" />
                  </span>
                  <span className="composer-config-summary-text">
                    <span className="composer-config-summary-title">
                      {t("composerConfiguration.modeTitle")}
                      <span className="composer-config-summary-suffix">
                        {" "}
                        ·{" "}
                        {active
                          ? modeLabel(active)
                          : t("composerConfiguration.loading")}
                      </span>
                    </span>
                    {view !== "model" && (
                      <span
                        className="composer-config-summary-hint"
                        data-tone={modelHintTone(active)}
                      >
                        {active
                          ? modeHint(active)
                          : t("composerConfiguration.loading")}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    aria-hidden
                    className="composer-config-chevron"
                  />
                </Collapsible.Trigger>
                {!mobile && view === "model" && moreButton}
              </div>
              <Collapsible.Content>
                <div className="composer-config-expanded">
                  <div
                    className={
                      mobile ? "composer-config-model-grid" : undefined
                    }
                  >
                    <SegmentControl
                      ariaLabel={t("composerConfiguration.modeTitle")}
                      className={
                        mobile
                          ? "composer-config-model-cards"
                          : "composer-config-segments"
                      }
                      items={favorites.map((entry) => ({
                        value: entry.name,
                        label: modeLabel(entry),
                        disabled: !available(entry),
                      }))}
                      value={configuration.mode}
                      onChange={selectMode}
                    />
                    {mobile && moreButton}
                  </div>
                  <p
                    className="composer-config-hint"
                    data-tone={modelHintTone(active)}
                    aria-live="polite"
                  >
                    {active
                      ? modeHint(active)
                      : t("composerConfiguration.loading")}
                  </p>
                </div>
              </Collapsible.Content>
            </Collapsible.Item>
          </Collapsible.Root>
          {!configuration.preferencesAvailable && (
            <p className="composer-config-hint composer-config-notice">
              {t(
                configuration.supportsPreferences
                  ? "composerConfiguration.preferencesUnavailable"
                  : "composerConfiguration.updateRequired",
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface ComposerSettingsMenuProps {
  configuration: ComposerConfiguration;
  pickers: Pick<
    ReturnType<typeof useComposerAttachmentPickers>,
    "camera" | "photos" | "files"
  >;
  disabled: boolean;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}

export function ComposerSettingsMenu(props: ComposerSettingsMenuProps) {
  const mobile = useTouchMobile();
  return <ComposerSettingsSurface {...props} mobile={mobile} />;
}

export function ComposerSettingsSurface({
  configuration,
  pickers,
  disabled,
  onMouseDown,
  mobile,
}: ComposerSettingsMenuProps & { mobile: boolean }) {
  const { t } = useTranslation("chat");
  const attachments = (
    <ComposerAttachmentActions mobile={mobile} pickers={pickers} />
  );
  const content = (
    <ComposerConfigurationContent
      configuration={configuration}
      attachments={attachments}
      mobile={mobile}
    />
  );
  const Root = mobile ? BottomSheet.Root : Popover.Root;
  return (
    <Root open={configuration.open} onOpenChange={configuration.setOpen}>
      <ComposerSettingsTrigger
        mobile={mobile}
        configuration={configuration}
        disabled={disabled}
        onMouseDown={onMouseDown}
      />
      {mobile ? (
        <>
          <BottomSheet.Content
            onEscapeKeyDown={(event) => event.preventDefault()}
            aria-describedby={undefined}
            padded={false}
            overlayClassName="bg-black/45"
            className="composer-config-theme composer-config-sheet"
          >
            <span aria-hidden="true" className="composer-config-grabber" />
            <BottomSheet.Header className="composer-config-sheet-header">
              <BottomSheet.Title className="composer-config-sheet-title">
                {t("composerConfiguration.title")}
              </BottomSheet.Title>
              <BottomSheet.Close
                aria-label={t("composerConfiguration.close")}
                className="flex size-11 items-center justify-center"
              >
                <X className="size-4" />
              </BottomSheet.Close>
            </BottomSheet.Header>
            {content}
          </BottomSheet.Content>
        </>
      ) : (
        <Popover.Content
          onEscapeKeyDown={(event) => event.preventDefault()}
          aria-label={t("composerConfiguration.title")}
          side="top"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          className="composer-config-theme composer-config-popover motion-reduce:animate-none"
        >
          {content}
        </Popover.Content>
      )}
    </Root>
  );
}

function ComposerSettingsTrigger({
  mobile,
  configuration,
  disabled,
  onMouseDown,
}: {
  mobile: boolean;
  configuration: ComposerConfiguration;
  disabled: boolean;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation("chat");
  const trigger = (
    <Button
      variant="ghost"
      size="large"
      className={`composer-config-theme composer-config-trigger ${mobile ? "rounded-full" : "rounded-xl"}`}
      disabled={disabled}
      onMouseDown={onMouseDown}
      iconOnly={<Plus className="size-5" />}
      iconOnlyGlyphClassName="size-5 [&_svg]:size-5"
      aria-label={t("composerConfiguration.title")}
      aria-expanded={configuration.open}
    >
      <span className="sr-only">{t("composerConfiguration.title")}</span>
    </Button>
  );
  return mobile ? (
    <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
  ) : (
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
  );
}

export function ComposerAttachmentActions({
  mobile,
  pickers,
}: {
  mobile: boolean;
  pickers: Pick<
    ReturnType<typeof useComposerAttachmentPickers>,
    "camera" | "photos" | "files"
  >;
}) {
  const { t } = useTranslation("chat");
  return mobile ? (
    <div className="grid grid-cols-3 gap-2">
      {[
        {
          icon: Camera,
          label: "composerConfiguration.camera" as const,
          action: pickers.camera,
        },
        {
          icon: Image,
          label: "composerConfiguration.photos" as const,
          action: pickers.photos,
        },
        {
          icon: File,
          label: "composerConfiguration.files" as const,
          action: pickers.files,
        },
      ].map(({ icon: Icon, label, action }) => (
        <Button
          key={label}
          variant="ghost"
          className="composer-config-attachment-tile"
          onClick={action}
        >
          <Icon className="size-5" />
          <span>{t(label)}</span>
        </Button>
      ))}
    </div>
  ) : (
    <Button
      variant="ghost"
      className="composer-config-attach"
      onClick={pickers.files}
      aria-keyshortcuts={acceleratorToAriaKeyShortcuts(ATTACH_SHORTCUT)}
    >
      <span className="composer-config-icon">
        <Paperclip aria-hidden className="size-[17px]" />
      </span>
      <span className="flex-1 text-left">
        {t("composerConfiguration.attach")}
      </span>
      <ShortcutKeys
        accelerator={ATTACH_SHORTCUT}
        variant="inline"
        aria-hidden
        className="text-[color:var(--content-secondary)] pointer-coarse:hidden"
      />
    </Button>
  );
}
