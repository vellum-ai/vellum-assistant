import SwiftUI

public struct VSidePanel<PinnedContent: View, Content: View>: View {
    public let title: String
    public let titleFont: Font
    public let uppercased: Bool
    public let contentPadding: EdgeInsets
    public var onClose: (() -> Void)? = nil
    @ViewBuilder public let pinnedContent: () -> PinnedContent
    @ViewBuilder public let content: () -> Content

    public init(title: String, titleFont: Font = VFont.titleLarge, uppercased: Bool = false, contentPadding: EdgeInsets = EdgeInsets(top: VSpacing.lg, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg), onClose: (() -> Void)? = nil, @ViewBuilder pinnedContent: @escaping () -> PinnedContent, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.titleFont = titleFont
        self.uppercased = uppercased
        self.contentPadding = contentPadding
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
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
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
            // `.containerRelativeFrame(.horizontal)` (rather than
            // `.frame(maxWidth: .infinity, alignment: .top)`) sizes the
            // padded content to the ScrollView's visible width without
            // emitting `_FlexFrameLayout`. A FlexFrame here would query
            // `explicitAlignment` recursively on every descendant — when
            // `content()` is a `LazyVStack` of streaming events the
            // cascade walks every realized cell on every layout pass,
            // O(n × depth), which has caused multi-second hangs in
            // sibling surfaces (see clients/macos/AGENTS.md
            // "No `_FlexFrameLayout` ... in LazyVStack" and the
            // matching `.containerRelativeFrame` adoption in
            // `HomeDetailPanel`).
            //
            // Reference: https://developer.apple.com/documentation/swiftui/view/containerrelativeframe(_:alignment:)
            ScrollView {
                content()
                    .padding(contentPadding)
                    .containerRelativeFrame(.horizontal, alignment: .top)
            }
            .layoutPriority(-1)
        }
    }
}

