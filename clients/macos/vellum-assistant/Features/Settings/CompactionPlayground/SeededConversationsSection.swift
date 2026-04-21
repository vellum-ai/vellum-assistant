import SwiftUI
import VellumAssistantShared

/// Stub for the Seeded Conversations subsection of the Compaction Playground tab.
///
/// Unlike the other subsections, this one is not scoped to a single
/// conversation — it lists/deletes all seeded conversations via
/// `CompactionPlaygroundClient.listSeededConversations()` /
/// `deleteSeededConversation(id:)` / `deleteAllSeededConversations()`.
/// A Wave-3 follow-up PR replaces this file wholesale with the real UI;
/// the parameter list is fixed so the replacement PR does not need to touch
/// the tab composition file.
struct SeededConversationsSection: View {
    let client: CompactionPlaygroundClient
    let conversationManager: ConversationManager
    let showToast: (String, ToastInfo.Style) -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Seeded Conversations")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            Text("Coming soon in a follow-up PR.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }
}
