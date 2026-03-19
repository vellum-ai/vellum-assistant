import SwiftUI
import VellumAssistantShared

struct MessageInspectorResponseTab: View {
    let entry: LLMRequestLogEntry

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Response sections")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentDefault)

                    Text(responseAvailabilityText)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(VColor.surfaceOverlay)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

                VEmptyState(
                    title: "Response data unavailable yet",
                    subtitle: "A dedicated response renderer will arrive in a follow-up PR.",
                    icon: VIcon.messageSquare.rawValue
                )
                .frame(minHeight: 280)
            }
            .padding(VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }

    private var responseAvailabilityText: String {
        let sectionCount = entry.responseSections?.count ?? 0

        if sectionCount == 0 {
            return "This call does not expose normalized response sections yet."
        }

        return "\(sectionCount) normalized response section(s) are present, but this placeholder tab is intentionally lightweight in this PR."
    }
}
