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
        if viewModel.queuedMessages.isEmpty {
            EmptyView()
        } else {
            drawerBody
        }
    }

    private var drawerBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            header
            rows
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
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private var header: some View {
        HStack {
            Text("Queue · \(viewModel.queuedMessages.count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer(minLength: VSpacing.sm)

            Button(action: cancelAll) {
                Text("Cancel all")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel all queued messages")
        }
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(Array(viewModel.queuedMessages.enumerated()), id: \.element.id) { index, message in
                QueuedMessageRow(
                    message: message,
                    positionLabel: "#\(index + 1)",
                    isTail: message.id == viewModel.tailQueuedMessageId,
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
            value: viewModel.queuedMessages.map(\.id)
        )
    }

    private func cancelAll() {
        for message in viewModel.queuedMessages {
            viewModel.deleteQueuedMessage(messageId: message.id)
        }
    }
}
