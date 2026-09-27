import {
  PERMISSION_GUIDE_MIN_HEIGHT,
  PERMISSION_GUIDE_MAX_HEIGHT,
} from "@vellumai/ipc-contract";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, GripVertical } from "lucide-react";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Typography } from "@vellumai/design-library/components/typography";

import { useAppTheme } from "@/hooks/use-app-theme";
import { scopedAvatarAccentVars } from "@/hooks/use-avatar-accent-var";
import { useClientFeatureFlagSync } from "@/hooks/use-client-feature-flag-sync";
import { useTranslation } from "@/i18n";
import { useIsSessionInitializing } from "@/stores/auth-store";
import {
  dismissPermissionGuide,
  dragPermissionApp,
  permissionGuideReady,
  revealPermissionApp,
} from "@/runtime/permission-setup";

import { usePermissionGuide } from "./use-permission-guide";
import "./permission-guide.css";

export function PermissionGuidePage() {
  const isSessionInitializing = useIsSessionInitializing();
  useClientFeatureFlagSync(!isSessionInitializing);
  useAppTheme();
  const { t } = useTranslation();
  const guide = usePermissionGuide();
  const [failed, setFailed] = useState(false);
  const guideId = guide?.id;
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const frame = content?.parentElement;
    if (guideId === undefined || !content || !frame) {
      return;
    }
    const report = () => {
      const style = getComputedStyle(frame);
      const inset =
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth);
      permissionGuideReady(
        guideId,
        Math.min(
          PERMISSION_GUIDE_MAX_HEIGHT,
          Math.max(
            PERMISSION_GUIDE_MIN_HEIGHT,
            Math.ceil(content.getBoundingClientRect().height + inset),
          ),
        ),
      );
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(content);
    return () => observer.disconnect();
  }, [guideId]);
  if (!guide) {
    return null;
  }
  const label = t(
    guide.kind === "screen"
      ? "systemPermissionsCard.screenLabel"
      : "permissionGuide.inputLabel",
  );
  const reveal = () => {
    void revealPermissionApp(guide.id).catch(() => setFailed(true));
  };
  return (
    <Card.Root
      asChild
      style={scopedAvatarAccentVars(guide.accentHex)}
      className="permission-guide flex h-screen items-center gap-3 overflow-hidden select-none shadow-[var(--shadow-popover)]"
    >
      <main>
        <Button
          className="shrink-0"
          variant="ghost"
          size="regular"
          iconOnly={<ChevronLeft />}
          aria-label={t("permissionGuide.back")}
          onClick={() => dismissPermissionGuide(guide.id)}
        />
        <div ref={contentRef} className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-3">
            <ArrowUp
              className="permission-arrow size-6 shrink-0 text-[var(--avatar-accent-fill,var(--primary-base))]"
              aria-hidden="true"
            />
            <Typography as="h1" variant="body-medium-default">
              {t("permissionGuide.dragInstruction", {
                app: guide.appName,
                permission: label,
              })}
            </Typography>
          </div>
          <Card.Root
            asChild
            interactive
            surface="overlay"
            padding="sm"
            className="flex cursor-grab items-center gap-3 active:cursor-grabbing"
          >
            <button
              type="button"
              draggable
              aria-label={t("permissionGuide.dragApp", { app: guide.appName })}
              onDragStart={(event) => {
                event.preventDefault();
                dragPermissionApp(guide.id);
              }}
              onClick={reveal}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--avatar-accent,var(--primary-base))_12%,transparent)]">
                <img
                  src={guide.appIcon}
                  alt=""
                  draggable={false}
                  className="size-8 object-contain"
                />
              </span>
              <Typography
                variant="body-large-default"
                className="min-w-0 flex-1 break-words"
              >
                {guide.appName}
              </Typography>
              <GripVertical
                className="size-4 shrink-0 text-[var(--content-tertiary)]"
                aria-hidden="true"
              />
            </button>
          </Card.Root>
          <div className="mt-2 flex items-center gap-2">
            {(guide.error || failed) && (
              <Typography
                variant="body-small-lighter"
                role="alert"
                className="text-[var(--system-negative-strong)]"
              >
                {t("permissionGuide.dragError")}
              </Typography>
            )}
            <Button
              variant="ghost"
              size="compact"
              className="ml-auto shrink-0"
              onClick={reveal}
            >
              {t("permissionGuide.showInFinder")}
            </Button>
          </div>
        </div>
      </main>
    </Card.Root>
  );
}
