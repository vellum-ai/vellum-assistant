import SwiftUI

/// Standardized modal container providing consistent chrome: title, optional
/// subtitle, scrollable content area, and an optional footer. Follows the
/// Figma modal specification — no dividers, no close button, no header bar.
public struct VModal<Content: View, Footer: View>: View {
    public let title: String
    public let subtitle: String?
    @ViewBuilder public let content: () -> Content
    @ViewBuilder public let footer: () -> Footer

    public init(
        title: String,
        subtitle: String? = nil,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.title = title
        self.subtitle = subtitle
        self.content = content
        self.footer = footer
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Title area
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.display)
                    .foregroundColor(VColor.contentDefault)
                if let subtitle {
                    Text(subtitle)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            // Scrollable content
            ScrollView {
                content()
                    .padding(.horizontal, VSpacing.xl)
                    .frame(maxWidth: .infinity, alignment: .top)
            }

            if Footer.self != EmptyView.self {
                // Footer
                footer()
                    .padding(.horizontal, VSpacing.xl)
                    .padding(.vertical, VSpacing.lg)
            }
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }
}

// Convenience: no footer.
public extension VModal where Footer == EmptyView {
    init(
        title: String,
        subtitle: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, subtitle: subtitle, content: content, footer: { EmptyView() })
    }
}
