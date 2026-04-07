import SwiftUI
import VellumAssistantShared

/// Standardized settings card with title, optional subtitle, optional accessory (top-right), and content.
/// Title and subtitle have 4pt spacing between them, with 16pt spacing to the content.
struct SettingsCard<Content: View, Accessory: View>: View {
    let title: String
    var subtitle: String? = nil
    var showBorder: Bool = true
    @ViewBuilder let accessory: () -> Accessory
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(title)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                    if let subtitle {
                        Text(subtitle)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                }
                Spacer()
                accessory()
            }
            content()
        }
        .padding(showBorder ? VSpacing.lg : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(ConditionalCardModifier(showBorder: showBorder))
    }
}

extension SettingsCard where Accessory == EmptyView {
    init(title: String, subtitle: String? = nil, showBorder: Bool = true, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.showBorder = showBorder
        self.accessory = { EmptyView() }
        self.content = content
    }
}

/// Conditionally applies vCard styling.
private struct ConditionalCardModifier: ViewModifier {
    let showBorder: Bool
    func body(content: Content) -> some View {
        if showBorder {
            content.vCard(background: VColor.surfaceLift)
        } else {
            content
        }
    }
}

/// A divider styled for settings cards (uses cardBorder color: E8E6DA light / 4A4A46 dark).
struct SettingsDivider: View {
    var body: some View {
        Rectangle()
            .fill(VColor.borderHover)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}
