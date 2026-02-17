import SwiftUI
import AppKit
import VellumAssistantShared

/// Displays a remote image with animated GIF support.
///
/// Uses a two-layer approach:
/// - SwiftUI `AsyncImage`-style state machine for layout and static images
/// - `NSViewRepresentable` wrapping `NSImageView` with `animates = true` for GIFs
///
/// The Coordinator tracks the current URL to prevent redundant downloads across
/// streaming re-renders (same pattern as `DinoSceneView` in `AvatarView.swift`).
struct AnimatedImageView: View {
    let urlString: String

    @State private var loadedImage: NSImage?
    @State private var imageData: Data?
    @State private var isLoading = true

    var body: some View {
        Group {
            if let data = imageData, isAnimatedGIF(data) {
                GIFView(data: data)
                    .frame(
                        width: min(imageSize.width, 280),
                        height: min(imageSize.height, 280)
                    )
            } else if let image = loadedImage {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                Image(systemName: "photo")
                    .font(.system(size: 24))
                    .foregroundColor(VColor.textMuted)
                    .frame(width: 80, height: 60)
            }
        }
        .task(id: urlString) {
            await loadImage()
        }
    }

    private var imageSize: CGSize {
        guard let image = loadedImage else { return CGSize(width: 280, height: 280) }
        let size = image.size
        guard size.width > 0, size.height > 0 else { return CGSize(width: 280, height: 280) }
        let scale = min(280 / size.width, 280 / size.height, 1.0)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    private func loadImage() async {
        isLoading = true
        defer { isLoading = false }

        // Support local file paths
        if urlString.hasPrefix("/") || urlString.hasPrefix("file://") {
            let fileURL = urlString.hasPrefix("file://")
                ? URL(string: urlString)
                : URL(fileURLWithPath: urlString)
            if let fileURL {
                imageData = try? Data(contentsOf: fileURL)
                loadedImage = imageData.flatMap { NSImage(data: $0) }
            }
            return
        }

        guard let url = URL(string: urlString) else { return }

        do {
            let data = try await ImageCache.shared.imageData(for: url)
            self.imageData = data
            self.loadedImage = NSImage(data: data)
        } catch {
            // Keep placeholder on failure
        }
    }

    private func isAnimatedGIF(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return false }
        return CGImageSourceGetCount(source) > 1
    }
}

/// NSViewRepresentable that renders animated GIF data via NSImageView.
private struct GIFView: NSViewRepresentable {
    let data: Data

    func makeNSView(context: Context) -> NSImageView {
        let imageView = NSImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.animates = true
        imageView.isEditable = false
        imageView.canDrawSubviewsIntoLayer = true
        if let image = NSImage(data: data) {
            imageView.image = image
        }
        return imageView
    }

    func updateNSView(_ nsView: NSImageView, context: Context) {
        // Data is immutable per GIF URL — no updates needed
    }
}
