import SwiftUI
import VellumAssistantShared

/// Expandable summary of queued (pending) messages shown above the composer.
///
/// Queued messages are kept out of the main chat feed to preserve
/// chronological order — they appear here as a collapsible stack so
/// the user knows their messages are waiting.
struct ChatQueueSummaryView: View {
    let queuedMessages: [ChatMessage]
    var onDeleteQueuedMessage: ((UUID) -> Void)?
    var onSendDirectQueuedMessage: ((UUID) -> Void)?
    var onReorderQueuedMessages: (([UUID]) -> Void)?
    @Binding var isExpanded: Bool

    var body: some View {
        if !queuedMessages.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                // Header
                Button {
                    withAnimation(VAnimation.fast) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                        Text("\(queuedMessages.count) Queued")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textSecondary)
                        Spacer()
                    }
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                // Message list
                if isExpanded {
                    VStack(spacing: VSpacing.xs) {
                        ForEach(queuedMessages, id: \.id) { message in
                            HStack(spacing: VSpacing.sm) {
                                if onReorderQueuedMessages != nil {
                                    Image(systemName: "line.3.horizontal")
                                        .font(.system(size: 10))
                                        .foregroundColor(VColor.textMuted)
                                        .accessibilityLabel("Drag to reorder")
                                } else {
                                    Circle()
                                        .fill(VColor.textMuted)
                                        .frame(width: 5, height: 5)
                                }
                                if message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    let names = message.attachments.map(\.filename).joined(separator: ", ")
                                    Label(names.isEmpty ? "Attachment" : names, systemImage: "paperclip")
                                        .font(VFont.body)
                                        .foregroundColor(VColor.textMuted)
                                        .lineLimit(1)
                                } else {
                                    Text(message.text)
                                        .font(VFont.body)
                                        .foregroundColor(VColor.textSecondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if let onSendDirect = onSendDirectQueuedMessage {
                                    Button {
                                        onSendDirect(message.id)
                                    } label: {
                                        Image(systemName: "arrow.up.circle.fill")
                                            .font(.system(size: 13))
                                            .foregroundColor(VColor.textMuted)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Send this message now")
                                }
                                if let onDelete = onDeleteQueuedMessage {
                                    Button {
                                        onDelete(message.id)
                                    } label: {
                                        Image(systemName: "trash")
                                            .font(.system(size: 11))
                                            .foregroundColor(VColor.textMuted)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Delete queued message")
                                }
                            }
                            .padding(.horizontal, VSpacing.lg)
                            .draggable(message.id.uuidString) {
                                Text(message.text.isEmpty ? "Attachment" : message.text)
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textSecondary)
                                    .lineLimit(1)
                                    .padding(.horizontal, VSpacing.sm)
                                    .padding(.vertical, VSpacing.xs)
                                    .background(VColor.surface)
                                    .cornerRadius(VRadius.sm)
                            }
                            .dropDestination(for: String.self) { items, _ in
                                guard let draggedIdStr = items.first,
                                      let draggedId = UUID(uuidString: draggedIdStr),
                                      draggedId != message.id else { return false }
                                reorderByDrop(draggedId: draggedId, targetId: message.id)
                                return true
                            } isTargeted: { _ in }
                        }
                    }
                    .padding(.bottom, VSpacing.sm)
                    .transition(.opacity)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.surfaceBorder, lineWidth: 1)
            )
            .padding(.horizontal, VSpacing.lg)
            .padding(.bottom, VSpacing.xs)
            .frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    private func reorderByDrop(draggedId: UUID, targetId: UUID) {
        var ids = queuedMessages.map(\.id)
        guard let fromIndex = ids.firstIndex(of: draggedId),
              let toIndex = ids.firstIndex(of: targetId) else { return }
        ids.remove(at: fromIndex)
        ids.insert(draggedId, at: toIndex)
        onReorderQueuedMessages?(ids)
    }
}
