import SwiftUI
import AppKit

/// Renders a remote image inline within a chat bubble.
///
/// Uses `AsyncImage` with three states: a loading spinner while the
/// image downloads, the fitted image on success, and an invisible
/// `EmptyView` on failure (the surrounding link text remains visible,
/// so silent failure avoids a broken-image placeholder).
///
/// Tapping the image opens the URL in the user's default browser.
struct InlineImageEmbedView: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .empty:
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.gray.opacity(0.15))
                    .frame(height: 120)
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
        .frame(maxWidth: .infinity, maxHeight: 300)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture {
            NSWorkspace.shared.open(url)
        }
    }
}
