import SwiftUI
import VellumAssistantShared

// MARK: - Queued Message Row

/// Single row rendered inside `QueuedMessagesDrawer`. Shows a position pill,
/// a truncated preview of the queued message text, and a trailing icon cluster
/// (pencil for the tail row, xmark for all rows).
///
/// The drawer owns interaction callbacks: `onEdit` is only invoked when the
/// pencil is visible (`isTail == true`); `onCancel` is always available.
struct QueuedMessageRow: View {
    let message: ChatMessage
    let positionLabel: String
    let isTail: Bool
    let onEdit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.md) {
            // (a) 2pt vertical accent bar signalling "held / pending".
            RoundedRectangle(cornerRadius: 1)
                .fill(VColor.systemPendingSoft)
                .frame(width: 2)
                .frame(maxHeight: .infinity)
                .accessibilityHidden(true)

            // (b) Position pill — tabular numerals so "#10" and "#1" align.
            Text(positionLabel)
                .font(VFont.numericMono)
                .foregroundStyle(VColor.contentSecondary)
                .padding(EdgeInsets(
                    top: VSpacing.xxs,
                    leading: VSpacing.sm,
                    bottom: VSpacing.xxs,
                    trailing: VSpacing.sm
                ))
                .background(
                    Capsule(style: .continuous)
                        .fill(VColor.surfaceLift)
                )

            // (c) Truncated content preview.
            Text(message.text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            // (d) Trailing icon cluster: pencil only when tail, xmark always.
            HStack(spacing: VSpacing.xs) {
                if isTail {
                    QueuedRowIconButton(icon: .pencil, accessibilityLabel: "Edit queued message", action: onEdit)
                }
                QueuedRowIconButton(icon: .x, accessibilityLabel: "Cancel queued message", action: onCancel)
            }
        }
        .padding(EdgeInsets(
            top: VSpacing.sm,
            leading: VSpacing.md,
            bottom: VSpacing.sm,
            trailing: VSpacing.md
        ))
        .contentShape(Rectangle())
    }
}

// MARK: - Icon Button

/// Trailing icon button used inside `QueuedMessageRow`. Matches the 24×24pt
/// hit target minimum called out in the plan, and swaps the foreground between
/// `contentSecondary` (resting) and `contentDefault` (hovered).
private struct QueuedRowIconButton: View {
    let icon: VIcon
    let accessibilityLabel: String
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VIconView(icon, size: 11)
                .foregroundStyle(isHovered ? VColor.contentDefault : VColor.contentSecondary)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .accessibilityLabel(accessibilityLabel)
    }
}
