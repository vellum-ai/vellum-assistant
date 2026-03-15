import SwiftUI
import VellumAssistantShared

/// Standardized settings card with title, optional subtitle, optional accessory (top-right), and content.
/// Title and subtitle have 4pt spacing between them, with 16pt spacing to the content.
struct SettingsCard<Content: View, Accessory: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder let accessory: () -> Accessory
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(title)
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentEmphasized)
                    if let subtitle {
                        Text(subtitle)
                            .font(VFont.sectionDescription)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }
                Spacer()
                accessory()
            }
            content()
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
    }
}

extension SettingsCard where Accessory == EmptyView {
    init(title: String, subtitle: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = { EmptyView() }
        self.content = content
    }
}

/// A divider styled for settings cards (uses cardBorder color: E8E6DA light / 4A4A46 dark).
struct SettingsDivider: View {
    var body: some View {
        Rectangle()
            .fill(VColor.borderDisabled)
            .frame(height: 1)
    }
}
