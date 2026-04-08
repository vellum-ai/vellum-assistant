import CoreGraphics
import ImageIO
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
            // Decode off the main thread via a CGImageSource on a background
            // task — per clients/AGENTS.md: "Never decode or resize images
            // synchronously on the main thread." CGImage is Sendable so it
            // crosses the actor boundary cleanly, unlike NSImage/UIImage.
            let cgImage: CGImage? = await Task.detached(priority: .userInitiated) {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
                    return nil
                }
                return CGImageSourceCreateImageAtIndex(source, 0, nil)
            }.value
            guard !Task.isCancelled else { return }
            if let cgImage {
                loadedImage = PlatformImage(fromCGImage: cgImage)
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
extension NSImage {
    /// Creates an `NSImage` from a decoded `CGImage`. Uses `.zero` to let the
    /// image infer its size from the underlying `CGImage` pixel dimensions.
    fileprivate convenience init(fromCGImage cgImage: CGImage) {
        self.init(cgImage: cgImage, size: .zero)
    }
}
#elseif canImport(UIKit)
import UIKit
public typealias PlatformImage = UIImage
extension Image {
    init(platformImage: PlatformImage) { self.init(uiImage: platformImage) }
}
extension UIImage {
    fileprivate convenience init(fromCGImage cgImage: CGImage) {
        self.init(cgImage: cgImage)
    }
}
#endif
