#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// The iOS queue drawer sits directly above `InputBarView` and lists every
/// user message currently in the conversation queue. Each row is a
/// `QueuedMessageRow_iOS`. When the queue is empty the drawer collapses to
/// `EmptyView` so it takes up no vertical space.
///
/// The drawer does not own keyboard/safe-area treatment — `ChatContentView`
/// already anchors `InputBarView` to the keyboard via its own layout, and this
/// drawer just sits as a sibling above it in the parent `VStack`.
struct QueuedMessagesDrawer_iOS: View {
    @Bindable var viewModel: ChatViewModel
    @Binding var composerText: String
    @Binding var composerAttachments: [ChatAttachment]

    var body: some View {
        // Cache `queuedMessages` and `tailQueuedMessageId` once per render —
        // both run filter+sorted on access (and `tailQueuedMessageId` is O(N)
        // and called per row via `isTail`).
        let queuedMessages = viewModel.queuedMessages
        let tailId = viewModel.tailQueuedMessageId
        if queuedMessages.isEmpty {
            EmptyView()
        } else {
            container(queuedMessages: queuedMessages, tailId: tailId)
        }
    }

    private func container(queuedMessages: [ChatMessage], tailId: UUID?) -> some View {
        // Computed once per render so the pencil button can be disabled when
        // the user has an in-progress composer draft. The view-model guard is
        // the source of truth, but the disabled state gives visual feedback.
        let isComposerEmpty = composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && composerAttachments.isEmpty
        return VStack(alignment: .leading, spacing: VSpacing.sm) {
            header(queuedMessages: queuedMessages)

            LazyVStack(spacing: 0) {
                ForEach(
                    Array(queuedMessages.enumerated()),
                    id: \.element.id
                ) { index, message in
                    QueuedMessageRow_iOS(
                        message: message,
                        positionLabel: "#\(index + 1)",
                        isTail: message.id == tailId,
                        isComposerEmpty: isComposerEmpty,
                        onEdit: {
                            viewModel.editQueuedTail(
                                into: $composerText,
                                attachments: $composerAttachments
                            )
                        },
                        onCancel: {
                            viewModel.deleteQueuedMessage(messageId: message.id)
                        }
                    )
                    .transition(.asymmetric(
                        insertion: .push(from: .bottom).combined(with: .opacity),
                        removal: .scale(scale: 0.92).combined(with: .opacity)
                    ))
                }
            }
            .animation(
                .spring(duration: 0.28, bounce: 0.15),
                value: queuedMessages.map(\.id)
            )
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VSpacing.md, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VSpacing.md, style: .continuous)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, VSpacing.md)
    }

    private func header(queuedMessages: [ChatMessage]) -> some View {
        HStack {
            Text("Queue · \(queuedMessages.count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer()

            Button("Cancel all") {
                for message in queuedMessages {
                    viewModel.deleteQueuedMessage(messageId: message.id)
                }
            }
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentSecondary)
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel all queued messages")
        }
    }
}
#endif
