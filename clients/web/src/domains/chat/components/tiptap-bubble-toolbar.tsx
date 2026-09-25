/**
 * The formatting toolbar that floats over a text selection in the document
 * editor: block style, inline marks, lists and quotes, links, and comments.
 * Link editing happens in place, in a field that replaces the button row,
 * since `window.prompt` does not exist in the Electron shell.
 */

import { type Editor, useEditorState } from "@tiptap/react";
import {
  Button,
  cn,
  Input,
  Menu,
  PortalContainerProvider,
} from "@vellumai/design-library";
import {
  Bold,
  ChevronDown,
  Code,
  CornerDownLeft,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  type LucideIcon,
  MessageSquareQuote,
  Pilcrow,
  Strikethrough,
  TextQuote,
  Unlink,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useState,
} from "react";

import {
  activeHighlightPluginKey,
  normalizeLinkHref,
} from "@/domains/chat/components/tiptap-editor-extensions";
import { pmPosToCharOffset } from "@/domains/chat/utils/tiptap-position-map";
import { useTranslation } from "@/i18n";

type BlockStyle = "paragraph" | "heading1" | "heading2" | "heading3";

const HEADING_LEVELS = { heading1: 1, heading2: 2, heading3: 3 } as const;

const BLOCK_STYLE_ICONS: Record<BlockStyle, LucideIcon> = {
  paragraph: Pilcrow,
  heading1: Heading1,
  heading2: Heading2,
  heading3: Heading3,
};

function currentBlockStyle(editor: Editor): BlockStyle {
  for (const [style, level] of Object.entries(HEADING_LEVELS)) {
    if (editor.isActive("heading", { level })) {
      return style as BlockStyle;
    }
  }
  return "paragraph";
}

function applyBlockStyle(editor: Editor, style: BlockStyle): void {
  const chain = editor.chain().focus();
  if (style === "paragraph") {
    chain.setParagraph().run();
  } else {
    chain.setHeading({ level: HEADING_LEVELS[style] }).run();
  }
}

function setActiveHighlight(
  editor: Editor,
  range: { start: number; end: number } | null,
): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(activeHighlightPluginKey, { range }),
  );
}

type Panel = "none" | "link" | "comment";

interface BubbleToolbarProps {
  editor: Editor;
  onCommentSubmit?: (comment: string) => void;
  commentSubmitting?: boolean;
}

export function BubbleToolbar({
  editor,
  onCommentSubmit,
  commentSubmitting,
}: BubbleToolbarProps) {
  const { t } = useTranslation("chat");
  const [panel, setPanel] = useState<Panel>("none");
  const [commentDraft, setCommentDraft] = useState("");
  const [linkDraft, setLinkDraft] = useState("");
  const [linkInvalid, setLinkInvalid] = useState(false);
  // The style menu portals into the toolbar itself. Focus that leaves the
  // toolbar's element makes the bubble menu hide, which would pull the menu's
  // trigger out from under it.
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(
    null,
  );

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      blockStyle: currentBlockStyle(ed),
      // `can()` needs the command manager, which exists only while the editor
      // is mounted; the toolbar also renders, hidden, outside that window.
      canHeading:
        !ed.isInitialized ||
        ed.isDestroyed ||
        ed.can().setHeading({ level: 1 }),
      bold: ed.isActive("bold"),
      italic: ed.isActive("italic"),
      strike: ed.isActive("strike"),
      code: ed.isActive("code"),
      bulletList: ed.isActive("bulletList"),
      orderedList: ed.isActive("orderedList"),
      blockquote: ed.isActive("blockquote"),
      link: ed.isActive("link"),
      linkHref: (ed.getAttributes("link").href as string | undefined) ?? "",
    }),
  });

  const closePanel = useCallback(() => {
    if (panel === "comment") {
      setActiveHighlight(editor, null);
    }
    setPanel("none");
    editor.commands.focus();
  }, [editor, panel]);

  const openLink = () => {
    if (panel === "comment") {
      setActiveHighlight(editor, null);
    }
    setLinkDraft(state.linkHref);
    setLinkInvalid(false);
    setPanel("link");
  };

  const toggleComment = () => {
    if (panel === "comment") {
      closePanel();
      return;
    }
    const { from, to } = editor.state.selection;
    if (from !== to) {
      setActiveHighlight(editor, {
        start: pmPosToCharOffset(editor.state.doc, from),
        end: pmPosToCharOffset(editor.state.doc, to),
      });
    }
    setPanel("comment");
  };

  const submitLink = () => {
    const href = normalizeLinkHref(linkDraft);
    if (!href) {
      setLinkInvalid(true);
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setPanel("none");
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setPanel("none");
  };

  const submitComment = () => {
    const comment = commentDraft.trim();
    if (!comment || commentSubmitting) {
      return;
    }
    onCommentSubmit?.(comment);
    setCommentDraft("");
    setPanel("none");
    setActiveHighlight(editor, null);
  };

  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Claimed here so the document drawer does not close as well.
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  };

  const StyleIcon = BLOCK_STYLE_ICONS[state.blockStyle];
  const blockStyleLabels: Record<BlockStyle, string> = {
    paragraph: t("tiptapDocumentEditor.paragraph"),
    heading1: t("tiptapDocumentEditor.heading1"),
    heading2: t("tiptapDocumentEditor.heading2"),
    heading3: t("tiptapDocumentEditor.heading3"),
  };

  const toggles: {
    key: string;
    label: string;
    icon: LucideIcon;
    active: boolean;
    run: () => void;
  }[][] = [
    [
      {
        key: "bold",
        label: t("tiptapDocumentEditor.bold"),
        icon: Bold,
        active: state.bold,
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        key: "italic",
        label: t("tiptapDocumentEditor.italic"),
        icon: Italic,
        active: state.italic,
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        key: "strike",
        label: t("tiptapDocumentEditor.strike"),
        icon: Strikethrough,
        active: state.strike,
        run: () => editor.chain().focus().toggleStrike().run(),
      },
      {
        key: "code",
        label: t("tiptapDocumentEditor.code"),
        icon: Code,
        active: state.code,
        run: () => editor.chain().focus().toggleCode().run(),
      },
    ],
    [
      {
        key: "bulletList",
        label: t("tiptapDocumentEditor.bulletList"),
        icon: List,
        active: state.bulletList,
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        key: "orderedList",
        label: t("tiptapDocumentEditor.orderedList"),
        icon: ListOrdered,
        active: state.orderedList,
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        key: "blockquote",
        label: t("tiptapDocumentEditor.blockquote"),
        icon: TextQuote,
        active: state.blockquote,
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
    ],
  ];

  return (
    <div
      ref={setToolbarElement}
      data-slot="document-bubble-toolbar"
      className={cn(
        "max-w-[calc(100vw-16px)] rounded-lg bg-[var(--surface-lift)]",
        "shadow-[var(--shadow-popover)]",
        "border border-[var(--border-base)]",
      )}
    >
      {panel === "link" ? (
        <form
          className="flex w-72 max-w-full items-start gap-1 p-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitLink();
          }}
        >
          <Input
            type="text"
            inputMode="url"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label={t("tiptapDocumentEditor.linkAddress")}
            placeholder={t("tiptapDocumentEditor.linkPlaceholder")}
            value={linkDraft}
            aria-invalid={linkInvalid}
            errorText={
              linkInvalid ? t("tiptapDocumentEditor.linkInvalid") : undefined
            }
            wrapperClassName="min-w-0 flex-1"
            onChange={(event) => {
              setLinkDraft(event.target.value);
              setLinkInvalid(false);
            }}
            onKeyDown={closeOnEscape}
          />
          <Button
            type="submit"
            variant="ghost"
            iconOnly={<CornerDownLeft />}
            expandOnMobile={false}
            aria-label={t("tiptapDocumentEditor.linkApply")}
            tooltip={t("tiptapDocumentEditor.linkApply")}
          />
          {state.link ? (
            <Button
              type="button"
              variant="ghost"
              iconOnly={<Unlink />}
              expandOnMobile={false}
              aria-label={t("tiptapDocumentEditor.linkRemove")}
              tooltip={t("tiptapDocumentEditor.linkRemove")}
              onClick={removeLink}
            />
          ) : null}
        </form>
      ) : (
        <div
          role="toolbar"
          aria-label={t("tiptapDocumentEditor.toolbarAria")}
          className="flex flex-wrap items-center gap-0.5 p-1"
        >
          <PortalContainerProvider container={toolbarElement}>
            <Menu.Root modal={false}>
              <Menu.Trigger>
                <Button
                  variant="ghost"
                  size="compact"
                  className="h-7 gap-0.5 px-1.5"
                  leftIcon={<StyleIcon />}
                  rightIcon={<ChevronDown />}
                  aria-label={t("tiptapDocumentEditor.textStyle", {
                    style: blockStyleLabels[state.blockStyle],
                  })}
                  tooltip={t("tiptapDocumentEditor.textStyle", {
                    style: blockStyleLabels[state.blockStyle],
                  })}
                />
              </Menu.Trigger>
              <Menu.Content
                align="start"
                className="min-w-40"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  editor.commands.focus();
                }}
              >
                <Menu.RadioGroup
                  value={state.blockStyle}
                  onValueChange={(value) =>
                    applyBlockStyle(editor, value as BlockStyle)
                  }
                >
                  {(Object.keys(BLOCK_STYLE_ICONS) as BlockStyle[]).map(
                    (style) => {
                      const Icon = BLOCK_STYLE_ICONS[style];
                      return (
                        <Menu.RadioItem
                          key={style}
                          value={style}
                          disabled={style !== "paragraph" && !state.canHeading}
                        >
                          <span className="flex items-center gap-2">
                            <Icon size={14} aria-hidden />
                            {blockStyleLabels[style]}
                          </span>
                        </Menu.RadioItem>
                      );
                    },
                  )}
                </Menu.RadioGroup>
              </Menu.Content>
            </Menu.Root>
          </PortalContainerProvider>

          {toggles.map((group) => (
            <span key={group[0]?.key} className="contents">
              <ToolbarSeparator />
              {group.map(({ key, label, icon: Icon, active, run }) => (
                <ToolbarButton
                  key={key}
                  label={label}
                  icon={<Icon />}
                  active={active}
                  onClick={run}
                />
              ))}
            </span>
          ))}

          <ToolbarSeparator />
          <ToolbarButton
            label={t("tiptapDocumentEditor.link")}
            icon={<LinkIcon />}
            active={state.link}
            onClick={openLink}
          />

          {onCommentSubmit ? (
            <>
              <ToolbarSeparator />
              <ToolbarButton
                label={t("tiptapDocumentEditor.comment")}
                icon={<MessageSquareQuote />}
                active={panel === "comment"}
                onClick={toggleComment}
              />
            </>
          ) : null}
        </div>
      )}

      {panel === "comment" ? (
        <div className="w-64 max-w-full border-t border-[var(--border-base)] p-2">
          <textarea
            className="w-full resize-none rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] px-3 py-2 text-body-medium-lighter text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] outline-none transition-[border-color] duration-150 ease-out focus-visible:border-[var(--border-active)]"
            rows={2}
            aria-label={t("tiptapDocumentEditor.comment")}
            placeholder={t("tiptapDocumentEditor.feedbackPlaceholder")}
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitComment();
                return;
              }
              closeOnEscape(e);
            }}
            autoFocus
          />
          <div className="mt-1.5 flex justify-end">
            <Button
              variant="primary"
              size="compact"
              onClick={submitComment}
              disabled={commentSubmitting || !commentDraft.trim()}
            >
              {commentSubmitting
                ? t("tiptapDocumentEditor.adding")
                : t("tiptapDocumentEditor.comment")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolbarSeparator() {
  return (
    <span aria-hidden className="mx-0.5 h-4 w-px bg-[var(--border-base)]" />
  );
}

function ToolbarButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactElement;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="compact"
      className="size-7"
      iconOnly={icon}
      expandOnMobile={false}
      active={active}
      aria-pressed={active}
      aria-label={label}
      tooltip={label}
      onClick={onClick}
    />
  );
}
