import SwiftUI
import VellumAssistantShared

/// Stub for the Event Log subsection of the Compaction Playground tab.
///
/// A Wave-3 follow-up PR replaces this file wholesale with UI that subscribes
/// to the compaction event stream scoped to `conversationId`. The parameter
/// list is fixed so the replacement PR does not need to touch the tab
/// composition file.
struct EventLogSection: View {
    let conversationId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Event Log")
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
