import SwiftUI
import VellumAssistantShared

/// Right-side detail panel used by the redesigned Home page.
///
/// Matches Figma nodes 3216:63021 (email editor) and 3216:63117 (invoice
/// preview) — a 601pt solid-white chrome with its own 16pt-rounded card
/// border, a header that hosts an optional icon chip + title + a single
/// trailing "Go to Thread" action + optional dismiss, and a scrolling
/// content area below a hairline divider.
///
/// The chrome is intentionally solid (not glass) so the panel reads as a
/// distinct work surface next to the floating glass recap cards on the
/// Home page. The header "Go to Thread" button uses `VButton.Size.regular`
/// (32pt tall, 8pt corners, 10pt horizontal padding) with the `.outlined`
/// style — a deliberate break from the fully-pill buttons used inside the
/// recap cards.
struct HomeDetailPanel<Content: View>: View {
    /// Default panel width from the Figma source (601pt). Callers almost
    /// always want this; exposed as a static so split-view hosts can size
    /// the trailing column without hard-coding a magic number.
    static var defaultWidth: CGFloat { 601 }

    let icon: VIcon?
    let title: String
    /// Tap handler for the trailing "Go to Thread" button in the header.
    /// Pass `nil` to hide the button (e.g. previews that don't surface a
    /// thread affordance).
    var onGoToThread: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil
    /// When `true` (default), the content area is wrapped in a vertical
    /// `ScrollView` so tall content like invoice images scrolls naturally.
    /// Pass `false` for bodies that want to fill the panel height and
    /// manage their own overflow — e.g. the email editor, which pins an
    /// attachments footer to the bottom and wants the body text field to
    /// expand into the empty space above it.
    var scrollable: Bool = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            VColor.borderBase
                .frame(height: 1)
                .accessibilityHidden(true)

            if scrollable {
                ScrollView {
                    content()
                        .frame(maxWidth: .infinity, alignment: .top)
                }
                .layoutPriority(1)
            } else {
                content()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .layoutPriority(1)
            }
        }
        .frame(width: Self.defaultWidth)
        .frame(maxHeight: .infinity)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl, style: .continuous)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
    }

    // MARK: - Header

    /// Header row: optional icon chip + title on the leading edge, and a
    /// single "Go to Thread" action + optional dismiss on the trailing edge.
    private var header: some View {
        HStack(spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if let icon {
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surfaceBase)
                        .frame(width: 32, height: 32)
                        .overlay {
                            VIconView(icon, size: 20)
                                .foregroundStyle(VColor.primaryBase)
                        }
                        .accessibilityHidden(true)
                }

                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                    .accessibilityAddTraits(.isHeader)
            }

            Spacer(minLength: 0)

            HStack(spacing: VSpacing.sm) {
                if let onGoToThread {
                    VButton(
                        label: "Go to Thread",
                        style: .outlined,
                        size: .regular,
                        action: onGoToThread
                    )
                }

                if let onDismiss {
                    VButton(
                        label: "Dismiss",
                        iconOnly: VIcon.x.rawValue,
                        style: .outlined,
                        size: .regular,
                        iconColor: VColor.primaryBase,
                        action: onDismiss
                    )
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
}
