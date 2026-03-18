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
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
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

#if DEBUG

private struct VModalPreviewWrapper: View {
    var body: some View {
        VModal(title: "Set PIN", subtitle: "This is a subtitle.") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Tool Name")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text("Select a Tool")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                        .padding(VSpacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Tool Name")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text("Select a Tool")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                        .padding(VSpacing.sm)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(VColor.surfaceActive)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {}
                VButton(label: "Confirm", style: .primary) {}
            }
        }
        .frame(width: 400, height: 320)
    }
}

#endif
