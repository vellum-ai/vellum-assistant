#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// A single row in the iOS queue drawer. Shows an amber accent bar, a numeric
/// position pill, and a truncated preview of the queued message. When the row
/// represents the tail of the queue, a pencil icon is rendered inline so the
/// user can pop the message back into the composer for editing. A trailing
/// swipe-to-cancel gesture is attached so swipes to the left destroy the row.
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
            // Amber accent bar — signals "held, waiting".
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(VColor.systemPendingSoft)
                .frame(width: 2)
                .frame(maxHeight: .infinity)

            // Position pill (#1, #2, ...). Tabular numerals keep digit widths
            // aligned so the column stays tidy as positions change.
            Text(positionLabel)
                .font(VFont.numericMono)
                .foregroundStyle(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs)
                .background(VColor.surfaceLift)
                .clipShape(Capsule())

            // Truncated preview of the queued message text.
            Text(message.text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Inline edit icon — only on the tail. Swipe-edit would be
            // ambiguous with the destructive swipe-to-cancel, so edit is
            // explicitly tap-only.
            if isTail {
                Button(action: onEdit) {
                    VIconView(.pencil, size: 14)
                        .foregroundStyle(VColor.contentSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Edit queued message")
            }
        }
        .frame(minHeight: 44)
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .contentShape(Rectangle())
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive, action: onCancel) {
                Label("Cancel", systemImage: "xmark.circle")
            }
        }
    }
}

#Preview("Tail row") {
    QueuedMessageRow_iOS(
        message: ChatMessage(
            role: .user,
            text: "Summarize the last three meetings and pull action items for the design review.",
            status: .queued(position: 2)
        ),
        positionLabel: "#3",
        isTail: true,
        onEdit: {},
        onCancel: {}
    )
    .padding()
    .background(VColor.surfaceBase)
}

#Preview("Mid row") {
    QueuedMessageRow_iOS(
        message: ChatMessage(
            role: .user,
            text: "Also check the latest Linear issues.",
            status: .queued(position: 0)
        ),
        positionLabel: "#1",
        isTail: false,
        onEdit: {},
        onCancel: {}
    )
    .padding()
    .background(VColor.surfaceBase)
}
#endif
