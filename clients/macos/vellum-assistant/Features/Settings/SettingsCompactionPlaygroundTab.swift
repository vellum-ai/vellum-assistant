import SwiftUI
import VellumAssistantShared

/// Developer-only Settings tab for the Compaction Playground.
///
/// Composes seven stub subsections — one per playground capability — so each
/// Wave-3 PR can replace exactly one subsection file without touching this
/// composition file or any sibling stub. The header surfaces the conversation
/// the playground operates on (read from `ConversationManager.activeConversation`)
/// so developers know which conversation a compact/seed/inject action will hit.
@MainActor
struct SettingsCompactionPlaygroundTab: View {
    @ObservedObject var store: SettingsStore
    var conversationManager: ConversationManager
    var showToast: (String, ToastInfo.Style) -> Void
    var onClose: () -> Void

    private let client = CompactionPlaygroundClient()

    @State private var activeConversationId: String?
    @State private var activeConversationTitle: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                headerCard

                ForceCompactSection(
                    conversationId: activeConversationId,
                    client: client,
                    showToast: showToast
                )
                SeedHistorySection(
                    conversationId: activeConversationId,
                    client: client,
                    conversationManager: conversationManager,
                    showToast: showToast,
                    onClose: onClose
                )
                SeededConversationsSection(
                    client: client,
                    conversationManager: conversationManager,
                    showToast: showToast,
                    onClose: onClose
                )
                InjectFailuresSection(
                    conversationId: activeConversationId,
                    client: client,
                    showToast: showToast
                )
                ResetCircuitSection(
                    conversationId: activeConversationId,
                    client: client,
                    showToast: showToast
                )
                StateDisplaySection(
                    conversationId: activeConversationId,
                    client: client
                )
                EventLogSection(
                    conversationId: activeConversationId,
                    conversationManager: conversationManager
                )
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear(perform: refreshActiveConversation)
        .onChange(of: conversationManager.activeConversationId) { _, _ in
            refreshActiveConversation()
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var headerCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Compaction Playground")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            if let id = activeConversationId {
                let title = activeConversationTitle ?? "Untitled"
                let truncated = truncatedId(id)
                Text("Operating on: \(title) (\(truncated))")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            } else {
                Text("Open a conversation in the main window, then return here to run playground actions.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    // MARK: - Helpers

    private func refreshActiveConversation() {
        let active = conversationManager.activeConversation
        activeConversationId = active?.conversationId
        activeConversationTitle = active?.title
    }

    private func truncatedId(_ id: String) -> String {
        guard id.count > 8 else { return id }
        return String(id.prefix(8)) + "…"
    }
}
