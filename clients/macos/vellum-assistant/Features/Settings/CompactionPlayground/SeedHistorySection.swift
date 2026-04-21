import SwiftUI
import VellumAssistantShared

/// Stub for the Seed History subsection of the Compaction Playground tab.
///
/// A Wave-3 follow-up PR replaces this file wholesale with UI that drives
/// `CompactionPlaygroundClient.seedConversation(...)` and (optionally) deep
/// links into the newly seeded conversation via `conversationManager` +
/// `onClose`. The parameter list is fixed so the replacement PR does not
/// need to touch the tab composition file.
struct SeedHistorySection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient
    let conversationManager: ConversationManager
    let showToast: (String, ToastInfo.Style) -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Seed History")
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
