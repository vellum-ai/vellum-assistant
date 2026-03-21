#if canImport(UIKit)
import SwiftUI
import UIKit
import VellumAssistantShared

// MARK: - ActivityViewController

/// Lightweight SwiftUI wrapper around UIActivityViewController for sharing content.
struct ActivityViewController: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - ChatTabView

struct ChatTabView: View {
    @StateObject private var viewModel: ChatViewModel
    @State private var showCopiedConfirmation = false
    @State private var showShareSheet = false
    @State private var shareMarkdown: String = ""

    init(connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(connectionManager: connectionManager, eventStreamClient: eventStreamClient))
    }

    var body: some View {
        ChatContentView(viewModel: viewModel)
            .onAppear {
                viewModel.consumeDeepLinkIfNeeded()
            }
            .onOpenURL { _ in
                DispatchQueue.main.async {
                    viewModel.consumeDeepLinkIfNeeded()
                }
            }
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    exportMenu(messages: viewModel.messages, conversationTitle: nil)
                }
            }
            .sheet(isPresented: $showShareSheet) {
                ActivityViewController(activityItems: [shareMarkdown])
            }
    }

    @ViewBuilder
    private func exportMenu(messages: [ChatMessage], conversationTitle: String?) -> some View {
        let hasTextMessages = messages.contains {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }

        Menu {
            Button {
                let markdown = buildMarkdown(messages: messages, conversationTitle: conversationTitle)
                guard !markdown.isEmpty else { return }
                UIPasteboard.general.string = markdown
                showCopiedConfirmation = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    showCopiedConfirmation = false
                }
            } label: {
                Label {
                    Text(showCopiedConfirmation ? "Copied!" : "Copy as Markdown")
                } icon: {
                    VIconView(showCopiedConfirmation ? .check : .copy, size: 14)
                }
            }

            Button {
                let markdown = buildMarkdown(messages: messages, conversationTitle: conversationTitle)
                guard !markdown.isEmpty else { return }
                shareMarkdown = markdown
                showShareSheet = true
            } label: {
                Label { Text("Share\u{2026}") } icon: { VIconView(.share, size: 14) }
            }
        } label: {
            VIconView(showCopiedConfirmation ? .check : .share, size: 20)
                .foregroundColor(showCopiedConfirmation ? VColor.systemPositiveStrong : VColor.contentTertiary)
        }
        .disabled(!hasTextMessages)
    }

    private func buildMarkdown(messages: [ChatMessage], conversationTitle: String?) -> String {
        let names = ChatTranscriptFormatter.ParticipantNames(
            assistantName: "Assistant",
            userName: "You"
        )
        return ChatTranscriptFormatter.conversationMarkdown(
            messages: messages,
            conversationTitle: conversationTitle,
            participantNames: names
        )
    }
}
#endif
