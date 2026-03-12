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
                        VIconView(isExpanded ? .chevronDown : .chevronRight, size: 10)
                            .foregroundColor(VColor.contentTertiary)
                        Text("\(queuedMessages.count) Queued")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.contentSecondary)
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
                                Circle()
                                    .fill(VColor.contentTertiary)
                                    .frame(width: 5, height: 5)
                                if message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                    // Attachment-only message — show filenames
                                    let names = message.attachments.map(\.filename).joined(separator: ", ")
                                    Label { Text(names.isEmpty ? "Attachment" : names) } icon: { VIconView(.paperclip, size: 14) }
                                        .font(VFont.body)
                                        .foregroundColor(VColor.contentTertiary)
                                        .lineLimit(1)
                                } else {
                                    Text(message.text)
                                        .font(VFont.body)
                                        .foregroundColor(VColor.contentSecondary)
                                        .lineLimit(1)
                                }
                                Spacer()
                                if let onSendDirect = onSendDirectQueuedMessage {
                                    Button {
                                        onSendDirect(message.id)
                                    } label: {
                                        VIconView(.circleArrowUp, size: 13)
                                            .foregroundColor(VColor.contentTertiary)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Send this message now")
                                }
                                if let onDelete = onDeleteQueuedMessage {
                                    Button {
                                        onDelete(message.id)
                                    } label: {
                                        VIconView(.trash, size: 11)
                                            .foregroundColor(VColor.contentTertiary)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Delete queued message")
                                }
                            }
                            .padding(.horizontal, VSpacing.lg)
                        }
                    }
                    .padding(.bottom, VSpacing.sm)
                    .transition(.opacity)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(VColor.surfaceBase)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
            .padding(.horizontal, VSpacing.lg)
            .padding(.bottom, VSpacing.xs)
            .frame(maxWidth: VSpacing.chatColumnMaxWidth)
            .frame(maxWidth: .infinity)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }
}
