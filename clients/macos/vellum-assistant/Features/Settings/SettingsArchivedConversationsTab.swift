import SwiftUI
import VellumAssistantShared

struct SettingsArchivedConversationsTab: View {
    var conversationManager: ConversationManager

    /// Read `archivedConversations` straight from the underlying
    /// `ConversationListStore` rather than through `ConversationManager`'s
    /// forwarder so the Observation dependency is anchored to the store
    /// that owns the mutation. Same pattern as the main sidebar fix for
    /// LUM-1002 — avoids a nested-facade observation hop that was masked
    /// pre-#26152 by `ObservableObject`'s whole-object invalidation.
    private var listStore: ConversationListStore { conversationManager.listStore }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if listStore.archivedConversations.isEmpty {
                GeometryReader { geo in
                    VEmptyState(
                        title: "No archived conversations",
                        subtitle: "Conversations you archive will appear here.",
                        icon: VIcon.archive.rawValue
                    )
                    .frame(width: geo.size.width, height: geo.size.height)
                }
                .frame(minHeight: 400)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(listStore.archivedConversations.enumerated()), id: \.element.id) { index, conversation in
                        if index > 0 {
                            SettingsDivider()
                        }
                        ArchivedConversationRow(conversation: conversation) {
                            conversationManager.unarchiveConversation(id: conversation.id)
                        }
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .vCard()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Archived Conversation Row

private struct ArchivedConversationRow: View {
    let conversation: ConversationModel
    let onUnarchive: () -> Void

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy, h:mm a"
        return f
    }()

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(conversation.title)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text("\(Self.dateFormatter.string(from: conversation.createdAt)) · \(conversation.source ?? "vellum-assistant")")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }

            Spacer()

            VButton(label: "Unarchive", style: .outlined) {
                onUnarchive()
            }
        }
        .padding(.vertical, VSpacing.sm)
    }
}

