import SwiftUI
import VellumAssistantShared

struct SettingsArchivedConversationsTab: View {
    @ObservedObject var conversationManager: ConversationManager

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if conversationManager.archivedConversations.isEmpty {
                VEmptyState(
                    title: "No archived conversations",
                    subtitle: "Conversations you archive will appear here.",
                    icon: VIcon.archive.rawValue
                )
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(conversationManager.archivedConversations.enumerated()), id: \.element.id) { index, conversation in
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
                .vCard(background: VColor.surfaceOverlay)
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
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text("\(Self.dateFormatter.string(from: conversation.createdAt)) · \(conversation.source ?? "vellum-assistant")")
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)
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

