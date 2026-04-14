import SwiftUI
import VellumAssistantShared

// MARK: - Queued Messages Drawer

/// Drawer rendered above the composer when one or more user messages are
/// waiting in the queue. Each queued message renders as a `QueuedMessageRow`
/// with a position pill, preview, and cancel icon; the tail row additionally
/// exposes an edit affordance that pops the message back into the composer
/// bindings and removes it from the queue.
///
/// Not yet wired into `ChatView` — call sites will be added in a later PR.
struct QueuedMessagesDrawer: View {
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
            drawerBody(queuedMessages: queuedMessages, tailId: tailId)
        }
    }

    private func drawerBody(queuedMessages: [ChatMessage], tailId: UUID?) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            header(queuedMessages: queuedMessages)
            rows(queuedMessages: queuedMessages, tailId: tailId)
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
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private func header(queuedMessages: [ChatMessage]) -> some View {
        HStack {
            Text("Queue · \(queuedMessages.count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer(minLength: VSpacing.sm)

            Button(action: { cancelAll(queuedMessages: queuedMessages) }) {
                Text("Cancel all")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel all queued messages")
        }
    }

    private func rows(queuedMessages: [ChatMessage], tailId: UUID?) -> some View {
        // Computed once per render so the pencil button can be disabled when
        // the user has an in-progress composer draft. The view-model guard is
        // the source of truth, but the disabled state gives visual feedback.
        let isComposerEmpty = composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && composerAttachments.isEmpty
        return VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(Array(queuedMessages.enumerated()), id: \.element.id) { index, message in
                QueuedMessageRow(
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

    private func cancelAll(queuedMessages: [ChatMessage]) {
        for message in queuedMessages {
            viewModel.deleteQueuedMessage(messageId: message.id)
        }
    }
}
