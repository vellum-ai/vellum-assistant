import SwiftUI
import VellumAssistantShared

/// Displays the message history for a selected inbox thread in a scrollable timeline,
/// with a reply composer bar at the bottom.
struct InboxThreadDetailView: View {
    let thread: InboxThread
    @ObservedObject var viewModel: InboxViewModel
    let onBack: () -> Void

    @State private var replyText: String = ""

    private var canSend: Bool {
        !replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !viewModel.isSendingReply
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header with back button and thread name
            HStack(spacing: VSpacing.sm) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(VFont.body)
                        .foregroundColor(VColor.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Back to inbox")

                Image(systemName: thread.channelIcon)
                    .font(VFont.body)
                    .foregroundColor(VColor.accent)
                    .accessibilityHidden(true)

                Text(thread.resolvedName)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)

            Divider()
                .background(VColor.surfaceBorder)

            // Message timeline
            if viewModel.isLoadingMessages {
                VStack {
                    Spacer()
                    VLoadingIndicator()
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = viewModel.messagesError {
                VEmptyState(
                    title: "Failed to load messages",
                    subtitle: error,
                    icon: "exclamationmark.triangle.fill"
                )
            } else if viewModel.messages.isEmpty {
                VEmptyState(
                    title: "No messages",
                    subtitle: "This conversation has no messages yet",
                    icon: "bubble.left.and.bubble.right"
                )
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: VSpacing.sm) {
                            ForEach(viewModel.messages) { message in
                                InboxMessageBubble(
                                    role: message.role,
                                    content: message.content,
                                    timestamp: message.createdAt
                                )
                                .id(message.id)
                            }
                        }
                        .padding(VSpacing.lg)
                    }
                    .onAppear {
                        if let lastMessage = viewModel.messages.last {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                    .onChange(of: viewModel.messages.count) {
                        if let lastMessage = viewModel.messages.last {
                            withAnimation(VAnimation.fast) {
                                proxy.scrollTo(lastMessage.id, anchor: .bottom)
                            }
                        }
                    }
                }
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Reply composer bar
            HStack(spacing: VSpacing.sm) {
                TextField("Reply...", text: $replyText)
                    .textFieldStyle(.plain)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .padding(.horizontal, VSpacing.md)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surface)
                    )
                    .onSubmit {
                        sendReply()
                    }

                Button(action: sendReply) {
                    Group {
                        if viewModel.isSendingReply {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 20, height: 20)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 24))
                        }
                    }
                    .foregroundColor(canSend ? VColor.accent : VColor.textMuted)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send reply")
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)

            // Send error display
            if let sendError = viewModel.sendReplyError {
                Text(sendError)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.xs)
            }
        }
        .task {
            await viewModel.loadMessages(conversationId: thread.conversationId)

            // Poll for new messages every 15 seconds while viewing this thread
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard !Task.isCancelled else { break }
                // Don't poll while user is sending a reply
                guard !viewModel.isSendingReply else { continue }
                await viewModel.loadMessages(conversationId: thread.conversationId, isPolling: true)
            }
        }
    }

    private func sendReply() {
        let content = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !viewModel.isSendingReply else { return }

        let conversationId = thread.conversationId
        replyText = ""

        Task {
            let success = await viewModel.sendReply(conversationId: conversationId, content: content)
            if !success {
                // Restore text so the user can retry
                replyText = content
            }
        }
    }
}

#if DEBUG
struct InboxThreadDetailView_Preview: PreviewProvider {
    static var previews: some View {
        InboxThreadDetailPreviewWrapper()
            .frame(width: 350, height: 500)
            .previewDisplayName("InboxThreadDetailView")
    }
}

private struct InboxThreadDetailPreviewWrapper: View {
    @State private var previewReplyText: String = ""

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                // Simulated header
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "chevron.left")
                        .font(VFont.body)
                        .foregroundColor(VColor.accent)
                    Image(systemName: "paperplane.fill")
                        .font(VFont.body)
                        .foregroundColor(VColor.accent)
                    Text("John Doe")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)

                Divider().background(VColor.surfaceBorder)

                // Simulated messages
                ScrollView {
                    LazyVStack(spacing: VSpacing.sm) {
                        InboxMessageBubble(
                            role: "user",
                            content: "Hello, I need help with my account.",
                            timestamp: Date().addingTimeInterval(-3600)
                        )
                        InboxMessageBubble(
                            role: "assistant",
                            content: "Hi! I'd be happy to help with your account. What seems to be the issue?",
                            timestamp: Date().addingTimeInterval(-3500)
                        )
                        InboxMessageBubble(
                            role: "user",
                            content: "I can't seem to log in anymore.",
                            timestamp: Date().addingTimeInterval(-3400)
                        )
                    }
                    .padding(VSpacing.lg)
                }

                Divider().background(VColor.surfaceBorder)

                // Simulated composer
                HStack(spacing: VSpacing.sm) {
                    TextField("Reply...", text: $previewReplyText)
                        .textFieldStyle(.plain)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .fill(VColor.surface)
                        )

                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 24))
                        .foregroundColor(previewReplyText.isEmpty ? VColor.textMuted : VColor.accent)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
            }
        }
    }
}
#endif
