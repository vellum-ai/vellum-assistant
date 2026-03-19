import SwiftUI
import VellumAssistantShared

struct MessageInspectorPromptTab: View {
    let entry: LLMRequestLogEntry

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Prompt sections")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)

                    Text(promptAvailabilityText)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VColor.surfaceOverlay)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

                VEmptyState(
                    title: "Prompt data unavailable yet",
                    subtitle: "A dedicated prompt renderer will arrive in a follow-up PR.",
                    icon: VIcon.scrollText.rawValue
                )
                .frame(minHeight: 280)
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private var promptAvailabilityText: String {
        let sectionCount = entry.requestSections?.count ?? 0

        if sectionCount == 0 {
            return "This call does not expose normalized prompt sections yet."
        }

        return "\(sectionCount) normalized prompt section(s) are present, but this placeholder tab is intentionally lightweight in this PR."
    }
}
