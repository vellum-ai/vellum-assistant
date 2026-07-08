import {
    ArrowDownToLine,
    ArrowLeft,
    ChevronDown,
    Code,
    Eye,
    FileText,
    Folder,
    Loader2,
    Trash2,
} from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { isMarkdown } from "@/components/file-markdown";
import { SkillLineageLink } from "@/components/skill-lineage-link";
import {
    isAvailableSkill,
    isRemovableSkill,
    type SkillFileEntry,
    type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { useSkillDetailFiles } from "@/domains/intelligence/skills/use-skill-detail-files";
import { Button, Card, Menu, SegmentControl } from "@vellumai/design-library";
import { SkillFileContent } from "./skill-file-content";
import { SkillIcon } from "./skill-icon";
import { SkillOriginBadge } from "./skill-origin-badge";

interface SkillDetailMobileProps {
  assistantId: string;
  skill: SkillInfo;
  onBack: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
  /**
   * Attached to the overlay root so the route-level `useEdgeSwipeBack` drag
   * transform tracks this surface. The overlay portals out of the page's DOM
   * subtree, so the owning page can't wrap it in its own ref'd container.
   */
  swipeContainerRef?: RefObject<HTMLDivElement | null>;
  /**
   * Source conversation this skill was distilled from (assistant-memory
   * skills only) — renders a quiet lineage link when present.
   */
  sourceConversationId?: string;
}

/**
 * Single-column phone layout for viewing a skill's details.
 *
 * Renders as a full-screen overlay that takes over the whole viewport — its own
 * back · title · trash action bar replaces the app's mobile chrome (hamburger /
 * home / search) and the Intelligence tab row, matching the iOS mock. The
 * overlay is portaled into `RootLayout`'s `#viewport-overlays` container so a
 * transformed layout ancestor can't scope its `position: fixed` (the same
 * pattern the chat-side mobile detail overlays use). When the portal target
 * isn't resolved yet (first paint / tests) it falls back to rendering inline.
 *
 * Mirrors the desktop `SkillDetail` data/behavior (via the shared
 * `useSkillDetailFiles` hook) but lays out top-to-bottom: a circular action bar,
 * a header block with the full (non-clamped) description, and a content card
 * whose header hosts an inline file dropdown (left) and an icon-only
 * Preview/Source segment control (right). Preview is disabled for non-markdown
 * files, which always render as source, and the view resets to Preview when the
 * active file changes.
 */
export function SkillDetailMobile({
  assistantId,
  skill,
  onBack,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
  swipeContainerRef,
  sourceConversationId,
}: SkillDetailMobileProps) {
  const available = isAvailableSkill(skill);
  const removable = isRemovableSkill(skill);

  const {
    fileEntries,
    setSelectedPath,
    activePath,
    activeFile,
    isFilesLoading,
    fileContent,
    isBinary,
    isContentLoading,
  } = useSkillDetailFiles(assistantId, skill.id);

  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");

  // Each newly opened file starts in preview.
  useEffect(() => {
    setViewMode("preview");
  }, [activePath]);

  // Resolve the full-screen portal target after commit (SSR-safe; the
  // element is mounted by RootLayout). Falls back to inline rendering when
  // absent (e.g. tests, first paint).
  const [overlayTarget, setOverlayTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setOverlayTarget(document.getElementById("viewport-overlays"));
  }, []);

  const activeIsMarkdown = activeFile
    ? isMarkdown(activeFile.name, undefined)
    : false;
  const effectiveViewMode = activeIsMarkdown ? viewMode : "raw";

  const overlay = (
    <div
      ref={swipeContainerRef}
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-[var(--surface-overlay)]"
      style={{
        paddingTop:
          "calc(8px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
        paddingBottom:
          "calc(8px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
        paddingLeft:
          "calc(12px + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
        paddingRight:
          "calc(12px + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
      }}
    >
      {/* Action bar */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          iconOnly={<ArrowLeft aria-hidden />}
          expandOnMobile
          aria-label="Back to skills"
          onClick={onBack}
          className="max-md:bg-[var(--surface-active)]"
        />
        <span
          className="min-w-0 flex-1 truncate px-2 text-center text-body-medium-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {skill.name}
        </span>
        <RightAction
          available={available}
          removable={removable}
          isInstalling={isInstalling}
          isRemoving={isRemoving}
          onInstall={onInstall}
          onRemove={onRemove}
        />
      </div>

      {/* Header block — 16px below the action bar */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <SkillIcon
              skill={skill}
              className="h-6 w-6 shrink-0 text-[22px] leading-none"
            />
            <h2
              className="min-w-0 truncate text-title-medium"
              style={{ color: "var(--content-emphasised)" }}
            >
              {skill.name}
            </h2>
          </div>
          <SkillOriginBadge origin={skill.origin} />
        </div>
        <p
          className="text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {skill.description}
        </p>
        <SkillLineageLink
          skill={{ origin: skill.origin, sourceConversationId }}
        />
      </div>

      {/* Content card — 24px below the description */}
      <Card.Root asChild noPadding>
        <div
          className="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-[var(--surface-lift)]"
          style={{ borderColor: "var(--border-hover)" }}
        >
          <div
            className="flex items-center justify-between gap-2 border-b px-3 py-2"
            style={{ borderColor: "var(--border-hover)" }}
          >
            <FileDropdown
              fileEntries={fileEntries}
              activePath={activePath}
              activeName={activeFile?.name ?? null}
              onSelect={setSelectedPath}
            />
            <SegmentControl<"preview" | "raw">
              iconOnly
              ariaLabel="File view mode"
              value={effectiveViewMode}
              onChange={setViewMode}
              items={[
                {
                  value: "preview",
                  label: "Preview",
                  icon: <Eye aria-hidden />,
                  disabled: !activeIsMarkdown,
                },
                {
                  value: "raw",
                  label: "Source",
                  icon: <Code aria-hidden />,
                },
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {isFilesLoading || isContentLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2
                  className="h-6 w-6 animate-spin"
                  style={{ color: "var(--content-tertiary)" }}
                />
              </div>
            ) : activeFile ? (
              <SkillFileContent
                fileName={activeFile.name}
                content={fileContent}
                isBinary={isBinary}
                viewMode={effectiveViewMode}
              />
            ) : (
              <p
                className="flex h-full items-center justify-center text-body-medium-lighter"
                style={{ color: "var(--content-tertiary)" }}
              >
                Select a file to view its contents.
              </p>
            )}
          </div>
        </div>
      </Card.Root>
    </div>
  );

  return overlayTarget ? createPortal(overlay, overlayTarget) : overlay;
}

function RightAction({
  available,
  removable,
  isInstalling,
  isRemoving,
  onInstall,
  onRemove,
}: {
  available: boolean;
  removable: boolean;
  isInstalling: boolean;
  isRemoving: boolean;
  onInstall?: () => void;
  onRemove?: () => void;
}) {
  if (isInstalling || isRemoving) {
    return (
      <Button
        variant="ghost"
        iconOnly={<Loader2 className="animate-spin" aria-hidden />}
        expandOnMobile
        disabled
        aria-label="Pending"
        className="max-md:bg-[var(--surface-active)]"
      />
    );
  }

  if (available) {
    return (
      <Button
        variant="ghost"
        iconOnly={<ArrowDownToLine aria-hidden />}
        expandOnMobile
        aria-label="Install skill"
        onClick={onInstall}
        disabled={!onInstall}
        className="max-md:bg-[var(--surface-active)]"
      />
    );
  }

  if (removable) {
    return (
      <Button
        variant="dangerGhost"
        iconOnly={<Trash2 aria-hidden />}
        expandOnMobile
        aria-label="Remove skill"
        onClick={onRemove}
        disabled={!onRemove}
        className="max-md:rounded-full max-md:bg-[var(--system-negative-weak)]"
      />
    );
  }

  // Bundled: not available and not removable.
  return (
    <Button
      variant="dangerGhost"
      iconOnly={<Trash2 aria-hidden />}
      expandOnMobile
      disabled
      title="Bundled skills cannot be removed"
      aria-label="Bundled skill cannot be removed"
      className="max-md:rounded-full max-md:bg-[var(--system-negative-weak)]"
    />
  );
}

function isDirectoryEntry(mimeType: string | null | undefined): boolean {
  return (mimeType ?? "").endsWith("/directory");
}

function FileDropdown({
  fileEntries,
  activePath,
  activeName,
  onSelect,
}: {
  fileEntries: SkillFileEntry[];
  activePath: string | null;
  activeName: string | null;
  onSelect: (path: string) => void;
}) {
  const label = activeName ?? "Select a file";

  if (fileEntries.length === 0) {
    return (
      <span
        className="flex min-w-0 items-center gap-2 text-body-medium-default"
        style={{ color: "var(--content-emphasised)" }}
      >
        <FileGlyph />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <Menu.Root>
      <Menu.Trigger>
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 rounded-md text-body-medium-default"
          style={{ color: "var(--content-emphasised)" }}
        >
          <FileGlyph />
          <span className="truncate">{label}</span>
          <ChevronDown
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--content-tertiary)" }}
            aria-hidden
          />
        </button>
      </Menu.Trigger>
      <Menu.Content align="start">
        {fileEntries.map((entry) => {
          const isDirectory = isDirectoryEntry(entry.mimeType);
          return (
            <Menu.Item
              key={entry.path}
              onSelect={() => onSelect(entry.path)}
              leftIcon={isDirectory ? <Folder /> : <FileText />}
              aria-current={entry.path === activePath ? "true" : undefined}
            >
              {entry.name}
            </Menu.Item>
          );
        })}
      </Menu.Content>
    </Menu.Root>
  );
}

function FileGlyph() {
  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)]"
      aria-hidden
    >
      <FileText
        className="h-4 w-4"
        style={{ color: "var(--content-secondary)" }}
      />
    </span>
  );
}
