import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Renders a remote image inline within a chat bubble.
///
/// Uses `AsyncImage` with three states: a loading spinner while the
/// image downloads, the fitted image on success, and an invisible
/// `EmptyView` on failure (the surrounding link text remains visible,
/// so silent failure avoids a broken-image placeholder).
///
/// Loading is deferred until the view scrolls into the visible area
/// (`onAppear`) so that long chat histories don't eagerly fetch every
/// image at once.
///
/// Tapping the image opens the URL in the user's default browser.

/// Caps content height at a maximum using the Layout protocol (O(1)).
/// Unlike `.frame(maxHeight:)` which creates `_FlexFrameLayout` with its
/// O(n × depth) alignment cascade, this measures the child once, caps the
/// reported height, and places the child within the capped bounds.
/// Unlike GeometryReader + PreferenceKey, this resolves in a single layout
/// pass — no @State round-trip, so no first-render flicker.
private struct HeightCapLayout: Layout {
    let cap: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let childSize = child.sizeThatFits(proposal)
        return CGSize(width: childSize.width, height: min(cap, childSize.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        child.place(
            at: bounds.origin,
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

public struct InlineImageEmbedView: View {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// Flipped to `true` by `onAppear`; prevents eager network fetches
    /// for images that are off-screen in long chat histories.
    @State private var isVisible = false

    public var body: some View {
        HeightCapLayout(cap: 300) {
            Group {
                if isVisible {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .empty:
                            placeholderSkeleton
                                .overlay(ProgressView())
                        case .success(let image):
                            image
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                        case .failure:
                            EmptyView()
                        @unknown default:
                            EmptyView()
                        }
                    }
                } else {
                    placeholderSkeleton
                }
            }
        }
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onAppear { isVisible = true }
        .onTapGesture {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #elseif os(iOS)
            UIApplication.shared.open(url)
            #endif
        }
    }

    /// Placeholder skeleton shown while the view is off-screen or the
    /// image is still downloading.
    private var placeholderSkeleton: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(VColor.surfaceOverlay)
            .frame(height: 120)
    }
}
