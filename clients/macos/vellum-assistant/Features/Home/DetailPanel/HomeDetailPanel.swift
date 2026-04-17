import SwiftUI
import VellumAssistantShared

/// Right-side detail panel used by the redesigned Home page.
///
/// Matches Figma nodes 3216:63021 (email editor) and 3216:63117 (invoice
/// preview) — a 601pt solid-white chrome with its own 16pt-rounded card
/// border, a header that hosts an optional icon chip + title + up to two
/// trailing actions + optional dismiss, and a scrolling content area
/// below a hairline divider.
///
/// The chrome is intentionally solid (not glass) so the panel reads as a
/// distinct work surface next to the floating glass recap cards on the
/// Home page. Header action buttons use `VButton.Size.regular` (32pt
/// tall, 8pt corners, 10pt horizontal padding) which matches the mock's
/// `rounded-[8px] h-[32px] px-[10px]` spec exactly — a deliberate break
/// from the fully-pill buttons used inside the recap cards.
struct HomeDetailPanel<Content: View>: View {
    /// Default panel width from the Figma source (601pt). Callers almost
    /// always want this; exposed as a static so split-view hosts can size
    /// the trailing column without hard-coding a magic number.
    static var defaultWidth: CGFloat { 601 }

    /// Describes one of the trailing header buttons (primary / secondary).
    struct Action {
        let label: String
        var style: VButton.Style = .primary
        let action: () -> Void
    }

    let icon: VIcon?
    let title: String
    var primaryAction: Action?   = nil
    var secondaryAction: Action? = nil
    var onDismiss: (() -> Void)? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            VColor.borderBase
                .frame(height: 1)
                .accessibilityHidden(true)

            ScrollView {
                content()
                    .frame(maxWidth: .infinity, alignment: .top)
            }
            .layoutPriority(1)
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

    /// Header row: optional icon chip + title on the leading edge, and up
    /// to two action buttons + optional dismiss on the trailing edge.
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
                }

                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentEmphasized)
                    .accessibilityAddTraits(.isHeader)
            }

            Spacer(minLength: 0)

            HStack(spacing: VSpacing.sm) {
                if let primaryAction {
                    VButton(
                        label: primaryAction.label,
                        style: primaryAction.style,
                        size: .regular,
                        action: primaryAction.action
                    )
                }

                if let secondaryAction {
                    VButton(
                        label: secondaryAction.label,
                        style: secondaryAction.style,
                        size: .regular,
                        action: secondaryAction.action
                    )
                }

                if let onDismiss {
                    VButton(
                        label: "Dismiss",
                        iconOnly: "lucide-x",
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
