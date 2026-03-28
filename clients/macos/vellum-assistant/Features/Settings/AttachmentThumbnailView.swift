import SwiftUI
import VellumAssistantShared

/// A small thumbnail preview for a single file attachment URL.
/// Images show an actual preview; videos show a generic icon.
struct AttachmentThumbnailView: View {
    let url: URL
    let onRemove: () -> Void

    @State private var loadedImage: NSImage?

    private static let thumbnailSize: CGFloat = 56
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

    private var isImage: Bool {
        Self.imageExtensions.contains(url.pathExtension.lowercased())
    }

    private var truncatedFilename: String {
        let name = url.lastPathComponent
        if name.count <= 10 { return name }
        return String(name.prefix(7)) + "..." + String(name.suffix(min(3, name.count)))
    }

    var body: some View {
        VStack(spacing: VSpacing.xxs) {
            ZStack(alignment: .topTrailing) {
                thumbnailContent
                    .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                removeButton
            }

            Text(truncatedFilename)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .lineLimit(1)
        }
        .task(id: url) {
            guard isImage else { return }
            let fileURL = url
            let image = await Task.detached {
                NSImage(contentsOf: fileURL)
            }.value
            loadedImage = image
        }
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if isImage, let nsImage = loadedImage {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFill()
        } else if isImage {
            // Loading placeholder for images
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        } else {
            // Video or unknown type — show generic video icon
            ZStack {
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBase)
                VIconView(.video, size: 20)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
    }

    private var removeButton: some View {
        Button(action: onRemove) {
            ZStack {
                Circle()
                    .fill(VColor.surfaceOverlay)
                    .frame(width: 16, height: 16)
                VIconView(.x, size: 10)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
        .buttonStyle(.plain)
        .offset(x: 4, y: -4)
        .accessibilityLabel("Remove attachment")
    }
}
