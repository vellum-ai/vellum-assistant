import SwiftUI

struct VEmptyState: View {
    let title: String
    var subtitle: String? = nil
    var icon: String? = nil

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            if let icon = icon {
                Image(systemName: icon)
                    .font(.system(size: 48))
                    .foregroundColor(VColor.textMuted)
            }
            Text(title)
                .font(VFont.mono)
                .foregroundColor(VColor.textMuted)
                .textCase(.uppercase)
            if let subtitle = subtitle {
                Text(subtitle)
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(subtitle ?? "")")
    }
}
