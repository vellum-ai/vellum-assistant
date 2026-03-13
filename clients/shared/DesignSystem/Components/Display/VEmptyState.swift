import SwiftUI

public struct VEmptyState: View {
    public let title: String
    public var subtitle: String? = nil
    public var icon: String? = nil

    public init(title: String, subtitle: String? = nil, icon: String? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.icon = icon
    }

    public var body: some View {
        VStack(spacing: VSpacing.lg) {
            if let icon = icon {
                VIconView(.resolve(icon), size: 48)
                    .foregroundColor(VColor.contentTertiary)
            }
            Text(title)
                .font(VFont.mono)
                .foregroundColor(VColor.contentTertiary)
            if let subtitle = subtitle {
                Text(subtitle)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(subtitle ?? "")")
    }
}

