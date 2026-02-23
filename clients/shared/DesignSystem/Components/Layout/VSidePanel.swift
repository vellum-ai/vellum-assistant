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
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if let onClose = onClose {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(VColor.textMuted)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close \(title)")
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.lg)

            Divider()
                .background(VColor.surfaceBorder)

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

// Backward-compatible init (no pinnedContent)
public extension VSidePanel where PinnedContent == EmptyView {
    init(title: String, titleFont: Font = VFont.panelTitle, uppercased: Bool = false, onClose: (() -> Void)? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, titleFont: titleFont, uppercased: uppercased, onClose: onClose,
                  pinnedContent: { EmptyView() }, content: content)
    }
}

#Preview("VSidePanel") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VSidePanel(title: "Inspector", onClose: {}) {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                Text("Panel content here")
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Text("With scrollable content area")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
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
            VColor.background.ignoresSafeArea()
            VSidePanel(title: "Control", onClose: {}, pinnedContent: {
                VSegmentedControl(
                    items: ["Profile", "Settings", "Channels", "Overview"],
                    selection: $tab
                )
                Divider().background(VColor.surfaceBorder)
            }) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    Text("Tab content here")
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    Text("The tab bar above stays pinned while this scrolls.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            }
        }
    }
}
#endif
