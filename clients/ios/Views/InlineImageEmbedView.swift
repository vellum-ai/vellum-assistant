#if canImport(UIKit)
import SwiftUI

/// Renders a remote image inline within a chat bubble on iOS.
///
/// Uses `AsyncImage` with deferred loading (only fetches when the view
/// appears on screen). Tapping the image opens it in Safari.
struct InlineImageEmbedView: View {
    let url: URL

    @State private var isVisible = false

    var body: some View {
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
            UIApplication.shared.open(url)
        }
    }

    private var placeholderSkeleton: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color.gray.opacity(0.15))
            .frame(maxWidth: .infinity)
            .frame(height: 120)
    }
}
#endif
