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
public struct InlineImageEmbedView: View {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// Flipped to `true` by `onAppear`; prevents eager network fetches
    /// for images that are off-screen in long chat histories.
    @State private var isVisible = false

    public var body: some View {
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
        .frame(maxWidth: .infinity, maxHeight: 300)
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
            .fill(VColor.surfaceBase)
            .frame(maxWidth: .infinity)
            .frame(height: 120)
    }
}
