import SwiftUI
import VellumAssistantShared

/// Right-side detail panel used by the redesigned Home page.
///
/// Matches Figma nodes 3216:63021 (email editor) and 3216:63117 (invoice
/// preview) — a 601pt solid-white chrome with its own 16pt-rounded card
/// border, a header that hosts an optional icon chip + title + trailing
/// actions ("Go to Convo" button, overflow menu, close), and a scrolling
/// content area below a hairline divider.
///
/// The chrome is intentionally solid (not glass) so the panel reads as a
/// distinct work surface next to the floating glass recap cards on the
/// Home page. The header "Go to Convo" button uses `VButton.Size.regular`
/// (32pt tall, 8pt corners, 10pt horizontal padding) with the `.outlined`
/// style — a deliberate break from the fully-pill buttons used inside the
/// recap cards.
struct HomeDetailPanel<Content: View>: View {
    /// Default panel width from the Figma source (601pt). Callers almost
    /// always want this; exposed as a static so split-view hosts can size
    /// the trailing column without hard-coding a magic number.
    static var defaultWidth: CGFloat { 601 }

    let icon: VIcon?
    /// Pass `nil` (or a whitespace-only string) to suppress the header title
    /// when the body already conveys it.
    let title: String?
    /// Optional foreground tint for the icon chip. Falls back to
    /// `VColor.primaryBase` when `nil`.
    var iconForeground: Color? = nil
    /// Optional background fill for the icon chip. Falls back to
    /// `VColor.surfaceBase` when `nil`.
    var iconBackground: Color? = nil
    /// Tap handler for the trailing "Go to Convo" button in the header.
    /// Pass `nil` to hide the button (e.g. when no conversation is
    /// associated with the feed item).
    var onGoToConvo: (() -> Void)? = nil
    /// Toggles the item between read and unread. Shown in the overflow
    /// menu; pass `nil` to hide the overflow menu entirely.
    var onMarkReadUnread: (() -> Void)? = nil
    /// Whether the item is currently in a "read" state (`seen` or
    /// `actedOn`). Drives the overflow menu label: "Mark as unread"
    /// when `true`, "Mark as read" when `false`.
    var isRead: Bool = false
    /// Dismisses the feed item. Shown in the overflow menu alongside
    /// mark-read/unread; pass `nil` to omit it from the menu.
    var onDismissItem: (() -> Void)? = nil
    /// Closes the detail panel without modifying the feed item.
    var onClose: (() -> Void)? = nil
    /// When `true` (default), the content area is wrapped in a vertical
    /// `ScrollView` so tall content like invoice images scrolls naturally.
    /// Pass `false` for bodies that want to fill the panel height and
    /// manage their own overflow — e.g. the email editor, which pins an
    /// attachments footer to the bottom and wants the body text field to
    /// expand into the empty space above it.
    var scrollable: Bool = true
    /// When `true`, render the 32pt persona avatar in the header's leading
    /// slot instead of the category icon chip. Used for assistant-initiated
    /// feed rows (`FeedItem.fromAssistant == true`) so the detail header
    /// matches its list-row counterpart.
    var showsPersonaAvatar: Bool = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            VColor.borderBase
                .frame(height: 1)
                .accessibilityHidden(true)

            if scrollable {
                GeometryReader { geo in
                    ScrollView {
                        content()
                            .frame(width: geo.size.width, alignment: .topLeading)
                    }
                }
                .layoutPriority(1)
            } else {
                content()
                    .layoutPriority(1)
            }

            Spacer(minLength: 0)
        }
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Header

    /// Header row: optional icon chip + title on the leading edge, and
    /// trailing actions — "Go to Convo" button, an overflow menu (ellipsis)
    /// with mark-read/unread and dismiss, and a close button.
    private var header: some View {
        HStack(spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if showsPersonaAvatar {
                    personaAvatar
                        .frame(width: 32, height: 32)
                        .accessibilityHidden(true)
                } else if let icon {
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(iconBackground ?? VColor.surfaceBase)
                        .frame(width: 32, height: 32)
                        .overlay {
                            VIconView(icon, size: 20)
                                .foregroundStyle(iconForeground ?? VColor.primaryBase)
                        }
                        .accessibilityHidden(true)
                }

                if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(title)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                        .accessibilityAddTraits(.isHeader)
                }
            }

            Spacer(minLength: 0)

            HStack(spacing: VSpacing.sm) {
                if let onGoToConvo {
                    VButton(
                        label: "Go to Convo",
                        style: .outlined,
                        size: .regular,
                        action: onGoToConvo
                    )
                }

                if onMarkReadUnread != nil || onDismissItem != nil {
                    overflowMenu
                }

                if let onClose {
                    VButton(
                        label: "Close",
                        iconOnly: VIcon.x.rawValue,
                        style: .outlined,
                        size: .regular,
                        iconColor: VColor.primaryBase,
                        action: onClose
                    )
                    .accessibilityLabel("Close detail panel")
                }
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.md,
            leading: VSpacing.lg,
            bottom: VSpacing.md,
            trailing: VSpacing.lg
        ))
    }

    /// Overflow menu behind a vertical ellipsis button, containing
    /// mark-read/unread and dismiss actions.
    ///
    /// The outlined chrome is painted on a `RoundedRectangle` sibling that
    /// sits *outside* the `Menu`. SwiftUI's `.borderlessButton` menu style
    /// flattens any shape modifiers nested inside the label, so the border
    /// has to live on a wrapping view to survive.
    private var overflowMenu: some View {
        RoundedRectangle(cornerRadius: VRadius.md)
            .stroke(VColor.borderElement, lineWidth: 1)
            .frame(width: 32, height: 32)
            .overlay {
                Menu {
                    if let onMarkReadUnread {
                        Button(action: onMarkReadUnread) {
                            Label(
                                isRead ? "Mark as unread" : "Mark as read",
                                systemImage: isRead ? "envelope.badge" : "envelope.open"
                            )
                        }
                    }
                    if let onDismissItem {
                        Button(action: onDismissItem) {
                            Label("Dismiss", systemImage: "xmark.circle")
                        }
                    }
                } label: {
                    VIconView(.ellipsis, size: 16)
                        .foregroundStyle(VColor.primaryBase)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .frame(width: 32, height: 32)
            }
            .pointerCursor()
            .accessibilityLabel("More options")
    }

    /// 32pt persona avatar rendered into the header's leading slot for
    /// assistant-initiated rows. Mirrors `HomeRecapRow.personaAvatar` at a
    /// larger size; a follow-up extraction can dedupe this with
    /// `HomePageView.greetingAvatar` and `HomeRecapRow.personaAvatar`.
    @ViewBuilder
    private var personaAvatar: some View {
        let appearance = AvatarAppearanceManager.shared
        let size: CGFloat = 32
        if appearance.customAvatarImage != nil {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: size,
                showBorder: false
            )
        } else if let bodyShape = appearance.characterBodyShape,
                  let eyes = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            AnimatedAvatarView(
                bodyShape: bodyShape,
                eyeStyle: eyes,
                color: color,
                size: size,
                entryAnimationEnabled: false
            )
            .frame(width: size, height: size)
        } else {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: size,
                showBorder: false
            )
        }
    }
}
