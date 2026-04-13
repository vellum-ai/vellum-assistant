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
        if viewModel.queuedMessages.isEmpty {
            EmptyView()
        } else {
            container
        }
    }

    private var container: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            header

            LazyVStack(spacing: 0) {
                ForEach(
                    Array(viewModel.queuedMessages.enumerated()),
                    id: \.element.id
                ) { index, message in
                    QueuedMessageRow_iOS(
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
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VSpacing.md, style: .continuous)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VSpacing.md, style: .continuous)
                .strokeBorder(VColor.borderBase, lineWidth: 1)
        )
        .padding(.horizontal, VSpacing.md)
    }

    private var header: some View {
        HStack {
            Text("Queue · \(viewModel.queuedMessages.count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            Spacer()

            Button("Cancel all") {
                for message in viewModel.queuedMessages {
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

#if DEBUG
@MainActor
private func previewViewModel(withQueue: Bool) -> ChatViewModel {
    let connectionManager = GatewayConnectionManager()
    let viewModel = ChatViewModel(
        connectionManager: connectionManager,
        eventStreamClient: connectionManager.eventStreamClient
    )
    if withQueue {
        viewModel.messages = [
            ChatMessage(
                role: .user,
                text: "Pull the latest analytics for the onboarding flow.",
                status: .queued(position: 0)
            ),
            ChatMessage(
                role: .user,
                text: "Also compare week-over-week activation.",
                status: .queued(position: 1)
            ),
            ChatMessage(
                role: .user,
                text: "And draft a summary email once we've confirmed the numbers.",
                status: .queued(position: 2)
            ),
        ]
    }
    return viewModel
}

#Preview("Three queued") {
    StatefulPreviewWrapper(("", [ChatAttachment]())) { text, attachments in
        VStack {
            Spacer()
            QueuedMessagesDrawer_iOS(
                viewModel: previewViewModel(withQueue: true),
                composerText: text,
                composerAttachments: attachments
            )
            Color.clear.frame(height: 80)
        }
        .background(VColor.surfaceBase)
    }
}

#Preview("Empty queue collapses") {
    StatefulPreviewWrapper(("", [ChatAttachment]())) { text, attachments in
        QueuedMessagesDrawer_iOS(
            viewModel: previewViewModel(withQueue: false),
            composerText: text,
            composerAttachments: attachments
        )
        .padding()
        .background(VColor.surfaceBase)
    }
}

/// Test helper that lets previews own two `@State` values and pass them as
/// bindings to a child view. Without this, previews can't construct a
/// `Binding` for the drawer's composer parameters.
private struct StatefulPreviewWrapper<Value1, Value2, Content: View>: View {
    @State private var value1: Value1
    @State private var value2: Value2
    private let content: (Binding<Value1>, Binding<Value2>) -> Content

    init(
        _ initial: (Value1, Value2),
        @ViewBuilder content: @escaping (Binding<Value1>, Binding<Value2>) -> Content
    ) {
        _value1 = State(initialValue: initial.0)
        _value2 = State(initialValue: initial.1)
        self.content = content
    }

    var body: some View {
        content($value1, $value2)
    }
}
#endif
#endif
