import SwiftUI
import VellumAssistantShared

/// Standardized settings card with title, optional subtitle, and content.
/// Title and subtitle have 4pt spacing between them, with 16pt spacing to the content.
struct SettingsCard<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(VFont.sectionDescription)
                        .foregroundColor(VColor.textMuted)
                }
            }
            content()
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
    }
}

/// A divider styled for settings cards (uses cardBorder color: E8E6DA light / 4A4A46 dark).
struct SettingsDivider: View {
    var body: some View {
        Rectangle()
            .fill(VColor.cardBorder)
            .frame(height: 1)
    }
}
