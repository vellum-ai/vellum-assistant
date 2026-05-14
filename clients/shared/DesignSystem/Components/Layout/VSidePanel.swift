import SwiftUI

public struct VSidePanel<PinnedContent: View, Content: View, TitleAccessory: View, HeaderTrailing: View>: View {
    public let title: String
    public let titleFont: Font
    public let uppercased: Bool
    public let contentPadding: EdgeInsets
    public var onClose: (() -> Void)? = nil
    @ViewBuilder public let titleAccessory: () -> TitleAccessory
    @ViewBuilder public let headerTrailing: () -> HeaderTrailing
    @ViewBuilder public let pinnedContent: () -> PinnedContent
    @ViewBuilder public let content: () -> Content

    @State private var scrollViewWidth: CGFloat = 0

    public init(
        title: String,
        titleFont: Font = VFont.titleLarge,
        uppercased: Bool = false,
        contentPadding: EdgeInsets = EdgeInsets(top: VSpacing.lg, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg),
        onClose: (() -> Void)? = nil,
        @ViewBuilder titleAccessory: @escaping () -> TitleAccessory,
        @ViewBuilder headerTrailing: @escaping () -> HeaderTrailing,
        @ViewBuilder pinnedContent: @escaping () -> PinnedContent,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.titleFont = titleFont
        self.uppercased = uppercased
        self.contentPadding = contentPadding
        self.onClose = onClose
        self.titleAccessory = titleAccessory
        self.headerTrailing = headerTrailing
        self.pinnedContent = pinnedContent
        self.content = content
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text(uppercased ? title.uppercased() : title)
                    .font(titleFont)
                    .foregroundStyle(VColor.contentDefault)
                titleAccessory()
                Spacer()
                headerTrailing()
                if let onClose = onClose {
                    VButton(label: "Close", iconOnly: "xmark", style: .ghost, action: onClose)
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
            //
            // The content width is measured from the ScrollView's actual
            // frame via onGeometryChange and applied as a fixed-width
            // `.frame(width:)`. This avoids two pitfalls:
            //
            //  1. `.frame(maxWidth: .infinity)` emits `_FlexFrameLayout`
            //     which queries `explicitAlignment` recursively on every
            //     descendant — when `content()` is a `LazyVStack` of
            //     streaming events the cascade walks every realized cell
            //     on every layout pass, O(n × depth), causing hangs.
            //
            //  2. `.containerRelativeFrame(.horizontal)` can resolve to
            //     the window instead of the ScrollView in certain layout
            //     hierarchies (e.g. when the ScrollView is inside a
            //     VStack with `.frame(width:)` from VSplitView), making
            //     the content wider than the panel.
            ScrollView {
                content()
                    .padding(contentPadding)
                    .frame(width: scrollViewWidth > 0 ? scrollViewWidth : nil, alignment: .topLeading)
            }
            .fixedWidth(scrollViewWidth > 0 ? scrollViewWidth : nil)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.width
            } action: { newWidth in
                scrollViewWidth = newWidth
            }
            .layoutPriority(-1)
        }
    }
}

// MARK: - Backward-compatible init (no titleAccessory / headerTrailing)

public extension VSidePanel where TitleAccessory == EmptyView, HeaderTrailing == EmptyView {
    init(
        title: String,
        titleFont: Font = VFont.titleLarge,
        uppercased: Bool = false,
        contentPadding: EdgeInsets = EdgeInsets(top: VSpacing.lg, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg),
        onClose: (() -> Void)? = nil,
        @ViewBuilder pinnedContent: @escaping () -> PinnedContent,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.titleFont = titleFont
        self.uppercased = uppercased
        self.contentPadding = contentPadding
        self.onClose = onClose
        self.titleAccessory = { EmptyView() }
        self.headerTrailing = { EmptyView() }
        self.pinnedContent = pinnedContent
        self.content = content
    }
}
