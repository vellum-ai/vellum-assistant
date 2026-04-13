#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// A single row in the iOS queue drawer. Shows an amber accent bar, a numeric
/// position pill, and a truncated preview of the queued message. The tail row
/// renders an inline pencil so the user can pop the message back into the
/// composer for editing; every row renders a trailing cancel (x) button.
///
/// Shape mirrors the macOS `QueuedMessageRow` but sized for touch: minimum
/// 44pt row height and 44x44pt icon hit areas per Apple HIG.
struct QueuedMessageRow_iOS: View {
    let message: ChatMessage
    let positionLabel: String
    let isTail: Bool
    let onEdit: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.md) {
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(VColor.systemPendingSoft)
                .frame(width: 2)
                .frame(maxHeight: .infinity)
                .accessibilityHidden(true)

            Text(positionLabel)
                .font(VFont.numericMono)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs)
                .background(VColor.surfaceLift)
                .clipShape(Capsule())

            Text(message.text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: VSpacing.xs) {
                if isTail {
                    QueuedRowIconButton(
                        icon: .pencil,
                        accessibilityLabel: "Edit queued message",
                        action: onEdit
                    )
                }
                QueuedRowIconButton(
                    icon: .x,
                    accessibilityLabel: "Cancel queued message",
                    action: onCancel
                )
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .contentShape(Rectangle())
    }
}

private struct QueuedRowIconButton: View {
    let icon: VIcon
    let accessibilityLabel: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VIconView(icon, size: 14)
                .foregroundStyle(VColor.contentSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}
#endif
