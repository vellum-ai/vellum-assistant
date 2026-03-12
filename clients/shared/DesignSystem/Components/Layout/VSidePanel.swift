import SwiftUI

public struct VSidePanel<PinnedContent: View, Content: View>: View {
    public let title: String
    public let titleFont: Font
    public let uppercased: Bool
    public var onClose: (() -> Void)? = nil
    @ViewBuilder public let pinnedContent: () -> PinnedContent
    @ViewBuilder public let content: () -> Content

    public init(title: String, titleFont: Font = VFont.panelTitle, uppercased: Bool = false, onClose: (() -> Void)? = nil, @ViewBuilder pinnedContent: @escaping () -> PinnedContent, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.titleFont = titleFont
        self.uppercased = uppercased
        self.onClose = onClose
        self.pinnedContent = pinnedContent
        self.content = content
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(uppercased ? title.uppercased() : title)
                    .font(titleFont)
                    .foregroundColor(VColor.contentDefault)
                Spacer()
                if let onClose = onClose {
                    VIconButton(label: "Close", icon: "xmark", iconOnly: true, action: onClose)
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider()
                .background(VColor.borderBase)

            // Pinned content (not scrollable)
            pinnedContent()

            // Scrollable content — lower priority so pinnedContent's
            // own ScrollView (e.g. TraceTimelineView) isn't starved.
            ScrollView {
                content()
                    .padding(VSpacing.lg)
                    .frame(maxWidth: .infinity, alignment: .top)
            }
            .layoutPriority(-1)
        }
    }
}

#Preview("VSidePanel") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VSidePanel(title: "Inspector", onClose: {}, pinnedContent: { EmptyView() }) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Panel content here")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                Text("With scrollable content area")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }
        }
    }
    .frame(width: 300, height: 300)
}

#if DEBUG
struct VSidePanel_PinnedContent_Preview: PreviewProvider {
    static var previews: some View {
        VSidePanelPinnedPreviewWrapper()
            .frame(width: 400, height: 350)
            .previewDisplayName("VSidePanel with Pinned Content")
    }
}

private struct VSidePanelPinnedPreviewWrapper: View {
    @State private var tab = 1

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            VSidePanel(title: "Control", onClose: {}, pinnedContent: {
                VSegmentedControl(
                    items: ["Profile", "Settings", "Channels", "Overview"],
                    selection: $tab
                )
                Divider().background(VColor.borderBase)
            }) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Tab content here")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentDefault)
                    Text("The tab bar above stays pinned while this scrolls.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                }
            }
        }
    }
}
#endif
