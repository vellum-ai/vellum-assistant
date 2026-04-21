import SwiftUI
import VellumAssistantShared

/// Stub for the Force Compact subsection of the Compaction Playground tab.
///
/// A Wave-3 follow-up PR replaces this file wholesale with the real UI that
/// calls `CompactionPlaygroundClient.forceCompact(conversationId:)`. The
/// parameter list is fixed so the replacement PR does not need to touch the
/// tab composition file.
struct ForceCompactSection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient
    let showToast: (String, ToastInfo.Style) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Force Compact")
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
