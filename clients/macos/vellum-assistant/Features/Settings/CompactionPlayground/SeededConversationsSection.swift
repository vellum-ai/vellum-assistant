import SwiftUI
import VellumAssistantShared

/// Seeded Conversations subsection of the Compaction Playground tab.
///
/// Lists every `[Playground] `-prefixed conversation the daemon knows about
/// via `CompactionPlaygroundClient.listSeededConversations()`. Per-row actions
/// open the conversation in the main window (via `conversationManager`) or
/// delete it individually; a "Delete All" button wipes every seeded
/// conversation after a confirmation alert. Non-playground conversations are
/// untouched — the server-side prefix check enforced by the daemon endpoints
/// keeps destructive actions safe.
struct SeededConversationsSection: View {
    let client: CompactionPlaygroundClient
    let conversationManager: ConversationManager
    let showToast: (String, ToastInfo.Style) -> Void
    let onClose: () -> Void

    @State private var conversations: [SeededConversationSummary] = []
    @State private var isLoading = false
    @State private var lastError: String?
    @State private var showingDeleteAllConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            header

            if let lastError {
                Text(lastError)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            } else if conversations.isEmpty {
                Text("No seeded conversations yet. Use Seed History above to create one.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            } else {
                conversationList
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
        .task {
            await refresh()
        }
        .alert("Delete all seeded conversations?", isPresented: $showingDeleteAllConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Delete All", role: .destructive) {
                Task { await deleteAll() }
            }
        } message: {
            Text("This will delete \(conversations.count) seeded conversations. This cannot be undone.")
        }
    }

    // MARK: - Subviews

    private var header: some View {
        HStack(spacing: VSpacing.sm) {
            Text("Seeded Conversations (\(conversations.count))")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            Spacer()

            VButton(
                label: "Refresh",
                style: .outlined,
                isDisabled: isLoading
            ) {
                Task { await refresh() }
            }

            VButton(
                label: "Delete All",
                style: .dangerOutline,
                isDisabled: conversations.isEmpty || isLoading
            ) {
                showingDeleteAllConfirmation = true
            }
        }
    }

    private var conversationList: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(Array(conversations.enumerated()), id: \.element.id) { index, conv in
                conversationRow(conv)
                if index < conversations.count - 1 {
                    Divider()
                }
            }
        }
    }

    private func conversationRow(_ conv: SeededConversationSummary) -> some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(conv.title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("\(conv.messageCount) messages · created \(formattedDate(conv.createdAt))")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            Spacer()

            VButton(
                label: "Open",
                style: .outlined,
                isDisabled: isLoading
            ) {
                _ = conversationManager.selectConversationByConversationId(conv.id)
                onClose()
            }

            VButton(
                label: "Delete",
                iconOnly: VIcon.trash.rawValue,
                style: .dangerGhost,
                isDisabled: isLoading
            ) {
                Task { await deleteOne(conv) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions

    private func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await client.listSeededConversations()
            conversations = response.conversations
            lastError = nil
        } catch CompactionPlaygroundError.notAvailable {
            lastError = "Playground endpoints disabled — enable the compaction-playground flag."
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func deleteOne(_ conv: SeededConversationSummary) async {
        do {
            _ = try await client.deleteSeededConversation(id: conv.id)
            await refresh()
        } catch {
            showToast("Delete failed: \(error.localizedDescription)", .error)
        }
    }

    private func deleteAll() async {
        do {
            let response = try await client.deleteAllSeededConversations()
            showToast("Deleted \(response.deletedCount) seeded conversations.", .success)
            await refresh()
        } catch {
            showToast("Delete all failed: \(error.localizedDescription)", .error)
        }
    }

    // MARK: - Formatting

    /// Formats a millisecond-since-epoch timestamp (from the daemon) as a
    /// short, locale-aware date+time string.
    private func formattedDate(_ millisecondsSinceEpoch: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(millisecondsSinceEpoch) / 1000)
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
