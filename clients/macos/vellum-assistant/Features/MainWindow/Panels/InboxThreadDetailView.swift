import SwiftUI
import VellumAssistantShared

/// Displays the message history for a selected inbox thread in a scrollable timeline.
struct InboxThreadDetailView: View {
    let thread: InboxThread
    @ObservedObject var viewModel: InboxViewModel
    let onBack: () -> Void

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
                        // Scroll to the latest message
                        if let lastMessage = viewModel.messages.last {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .task {
            await viewModel.loadMessages(conversationId: thread.conversationId)
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
            }
        }
    }
}
#endif
