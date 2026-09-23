import {
  PERMISSION_GUIDE_MIN_HEIGHT,
  PERMISSION_GUIDE_MAX_HEIGHT,
} from "@vellumai/ipc-contract";
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, GripVertical } from "lucide-react";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { useTranslation } from "@/i18n";
import {
  dismissPermissionGuide,
  dragPermissionApp,
  permissionGuideReady,
  revealPermissionApp,
} from "@/runtime/permission-setup";
import { usePermissionGuide } from "./use-permission-guide";
import "./permission-guide.css";

export function PermissionGuidePage() {
  const { t } = useTranslation();
  const guide = usePermissionGuide();
  const [failed, setFailed] = useState(false);
  const guideId = guide?.id;
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (guideId === undefined || !content) {
      return;
    }
    const report = () =>
      permissionGuideReady(
        guideId,
        Math.min(
          PERMISSION_GUIDE_MAX_HEIGHT,
          Math.max(
            PERMISSION_GUIDE_MIN_HEIGHT,
            Math.ceil(content.getBoundingClientRect().height) + 30,
          ),
        ),
      );
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
    <main className="permission-guide" data-theme="dark">
      <Button
        className="permission-back"
        variant="outlined"
        shape="pill"
        size="regular"
        iconOnly={<ChevronLeft />}
        aria-label={t("permissionGuide.back")}
        onClick={() => dismissPermissionGuide(guide.id)}
      />
      <div ref={contentRef} className="permission-guide-content">
        <div className="permission-guide-heading">
          <ArrowUp
            className="permission-arrow"
            size={30}
            strokeWidth={3}
            aria-hidden="true"
          />
          <Typography as="h1" variant="body-medium-default">
            {t("permissionGuide.dragInstruction", {
              app: guide.appName,
              permission: label,
            })}
          </Typography>
        </div>
        <button
          className="permission-drag-app"
          draggable
          aria-label={t("permissionGuide.dragApp", { app: guide.appName })}
          onDragStart={(event) => {
            event.preventDefault();
            dragPermissionApp(guide.id);
          }}
          onClick={reveal}
        >
          <img src={guide.appIcon} alt="" draggable={false} />
          <Typography variant="body-large-default">{guide.appName}</Typography>
          <GripVertical size={18} aria-hidden="true" />
        </button>
        <div className="permission-guide-footer">
          {(guide.error || failed) && (
            <Typography variant="body-small-lighter" role="alert">
              {t("permissionGuide.dragError")}
            </Typography>
          )}
          <Button variant="ghost" size="compact" onClick={reveal}>
            {t("permissionGuide.showInFinder")}
          </Button>
        </div>
      </div>
    </main>
  );
}
