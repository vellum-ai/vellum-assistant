import SwiftUI

/// Shared URL session with a disk-backed cache for small remote images
/// (logos, avatars, etc.). Uses a dedicated cache directory so the images
/// persist across app launches and do not share budget with other HTTP
/// traffic on `URLSession.shared`.
public enum VRemoteImageCache {
    /// 32 MB memory, 128 MB disk — plenty of headroom for a couple
    /// hundred integration logos at a few KB each.
    private static let memoryCapacity = 32 * 1024 * 1024
    private static let diskCapacity = 128 * 1024 * 1024

    public static let session: URLSession = {
        let cacheDir = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("VellumRemoteImages", isDirectory: true)
        let cache = URLCache(
            memoryCapacity: memoryCapacity,
            diskCapacity: diskCapacity,
            directory: cacheDir
        )
        let config = URLSessionConfiguration.default
        config.urlCache = cache
        config.requestCachePolicy = .returnCacheDataElseLoad
        return URLSession(configuration: config)
    }()
}

/// A SwiftUI view that loads a remote image through `VRemoteImageCache.session`
/// and renders `placeholder` while loading or on error.
///
/// **Intended for small images only** (logos, avatars at a few KB each). The
/// decode path runs on the MainActor via `NSImage(data:)` / `UIImage(data:)`,
/// which is safe for Simple Icons-sized assets but would cause scroll jank for
/// large photos. For high-res images, use a different primitive that decodes
/// on a background task.
///
/// We deliberately decode through `PlatformImage(data:)` rather than
/// `CGImageSource` so SVG payloads (the format every `cdn.simpleicons.org`
/// URL returns) are handled correctly. `CGImageSource` only supports raster
/// formats (PNG/JPEG/GIF/HEIC); `NSImage`/`UIImage` understand both raster
/// and SVG on macOS 14+ / iOS 17+.
///
/// `VCachedRemoteImage` deliberately does NOT render a system `AsyncImage` — it
/// owns the session so the cache is shared and the call site can customize the
/// content/placeholder without styling inconsistencies.
public struct VCachedRemoteImage<Content: View, Placeholder: View>: View {
    private let url: URL?
    private let content: (Image) -> Content
    private let placeholder: () -> Placeholder

    @State private var loadedImage: PlatformImage?

    public init(
        url: URL?,
        @ViewBuilder content: @escaping (Image) -> Content,
        @ViewBuilder placeholder: @escaping () -> Placeholder
    ) {
        self.url = url
        self.content = content
        self.placeholder = placeholder
    }

    public var body: some View {
        Group {
            if let image = loadedImage {
                content(Image(platformImage: image))
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            await load()
        }
    }

    private func load() async {
        loadedImage = nil
        guard let url else { return }
        do {
            let (data, _) = try await VRemoteImageCache.session.data(from: url)
            guard !Task.isCancelled else { return }
            // Decode on the MainActor via NSImage(data:) / UIImage(data:).
            // These support BOTH raster formats (PNG/JPEG/GIF/HEIC) and SVG
            // on macOS 14+ / iOS 17+. CGImageSource was used previously but
            // does not decode SVG, which broke every cdn.simpleicons.org URL
            // (the primary use case for this component). The MainActor decode
            // cost is acceptable here because this component is constrained
            // to small images (logos/avatars at a few KB each).
            if let img = PlatformImage(data: data) {
                loadedImage = img
            }
        } catch {
            // Load failed — placeholder remains visible.
        }
    }
}

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit
public typealias PlatformImage = NSImage
extension Image {
    init(platformImage: PlatformImage) { self.init(nsImage: platformImage) }
}
#elseif canImport(UIKit)
import UIKit
public typealias PlatformImage = UIImage
extension Image {
    init(platformImage: PlatformImage) { self.init(uiImage: platformImage) }
}
#endif
