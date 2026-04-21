import SwiftUI
import VellumAssistantShared

/// Stub for the State Display subsection of the Compaction Playground tab.
///
/// A Wave-3 follow-up PR replaces this file wholesale with UI that polls
/// `CompactionPlaygroundClient.getState(conversationId:)` and renders the
/// current compaction state (token counts, circuit status, last attempt).
/// The parameter list is fixed so the replacement PR does not need to touch
/// the tab composition file.
struct StateDisplaySection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("State Display")
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
