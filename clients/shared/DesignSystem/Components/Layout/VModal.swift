import SwiftUI

/// Standardized modal container providing consistent chrome: header with title
/// and close button, scrollable content area, and an optional footer separated
/// by dividers. Modeled after `VSidePanel` for panels.
public struct VModal<HeaderActions: View, Content: View, Footer: View>: View {
    public let title: String
    public let titleIcon: VIcon?
    public let titleFont: Font
    public let onClose: () -> Void
    @ViewBuilder public let headerActions: () -> HeaderActions
    @ViewBuilder public let content: () -> Content
    @ViewBuilder public let footer: () -> Footer

    public init(
        title: String,
        titleIcon: VIcon? = nil,
        titleFont: Font = VFont.display,
        onClose: @escaping () -> Void,
        @ViewBuilder headerActions: @escaping () -> HeaderActions,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.title = title
        self.titleIcon = titleIcon
        self.titleFont = titleFont
        self.onClose = onClose
        self.headerActions = headerActions
        self.content = content
        self.footer = footer
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: VSpacing.sm) {
                if let titleIcon {
                    VIconView(titleIcon, size: 14)
                        .foregroundColor(VColor.primaryBase)
                }
                Text(title)
                    .font(titleFont)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)
                Spacer()
                headerActions()
                VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost, action: onClose)
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.lg)

            Divider().background(VColor.borderBase)

            // Scrollable content
            ScrollView {
                content()
                    .padding(VSpacing.xl)
                    .frame(maxWidth: .infinity, alignment: .top)
            }

            if Footer.self != EmptyView.self {
                Divider().background(VColor.borderBase)

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

// Convenience: no header actions, no footer.
public extension VModal where HeaderActions == EmptyView, Footer == EmptyView {
    init(
        title: String,
        titleIcon: VIcon? = nil,
        titleFont: Font = VFont.display,
        onClose: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, titleIcon: titleIcon, titleFont: titleFont, onClose: onClose, headerActions: { EmptyView() }, content: content, footer: { EmptyView() })
    }
}

// Convenience: no header actions, with footer.
public extension VModal where HeaderActions == EmptyView {
    init(
        title: String,
        titleIcon: VIcon? = nil,
        titleFont: Font = VFont.display,
        onClose: @escaping () -> Void,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.init(title: title, titleIcon: titleIcon, titleFont: titleFont, onClose: onClose, headerActions: { EmptyView() }, content: content, footer: footer)
    }
}

// Convenience: with header actions, no footer.
public extension VModal where Footer == EmptyView {
    init(
        title: String,
        titleIcon: VIcon? = nil,
        titleFont: Font = VFont.display,
        onClose: @escaping () -> Void,
        @ViewBuilder headerActions: @escaping () -> HeaderActions,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, titleIcon: titleIcon, titleFont: titleFont, onClose: onClose, headerActions: headerActions, content: content, footer: { EmptyView() })
    }
}

#if DEBUG

private struct VModalPreviewWrapper: View {
    var body: some View {
        VModal(title: "Example Modal", titleIcon: .sparkles, onClose: {}) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Modal content goes here")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Text("This modal has a standard header with icon, title, and close button.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }
        } footer: {
            HStack {
                Button {
                } label: {
                    Text("Cancel")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                Spacer()
                VButton(label: "Confirm", style: .primary) {}
            }
        }
        .frame(width: 400, height: 300)
    }
}

#endif
