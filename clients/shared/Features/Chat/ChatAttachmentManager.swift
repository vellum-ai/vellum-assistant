import Foundation
import os
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatAttachmentManager")

/// Async-compatible semaphore that suspends (not blocks) waiting tasks.
/// Drop-in replacement for DispatchSemaphore in structured concurrency contexts,
/// avoiding thread starvation on the cooperative thread pool.
private actor AsyncSemaphore {
    private var count: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(value: Int) { self.count = value }

    func wait() async {
        if count > 0 { count -= 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func signal() {
        if let next = waiters.first {
            waiters.removeFirst()
            next.resume()
        } else {
            count += 1
        }
    }
}

/// Owns the pending-attachment list and all attachment-manipulation methods that
/// were previously part of ChatViewModel / ChatViewModel+Attachments.
/// ChatViewModel holds a reference to this object and forwards reads/writes via
/// computed properties so every existing call site continues to compile without
/// modification.
@MainActor
public final class ChatAttachmentManager: ObservableObject {

    @Published public var pendingAttachments: [ChatAttachment] = []
    /// True while at least one attachment is being loaded in the background.
    /// The send button checks this so a user can't send before async load finishes.
    @Published public var isLoadingAttachment: Bool = false

    // Counts in-flight background loads; isLoadingAttachment is true when > 0.
    private var loadingCount: Int = 0 {
        didSet { isLoadingAttachment = loadingCount > 0 }
    }

    /// Limits concurrent attachment I/O to keep memory usage reasonable.
    private static let maxConcurrentLoads = 4
    private let loadSemaphore = AsyncSemaphore(value: maxConcurrentLoads)

    /// Memory safety limit to avoid OOM from loading extremely large files.
    /// This is NOT a business rule — the server enforces its own size limits.
    private static let memorySafetyLimit = 100 * 1024 * 1024

    /// Maximum image size before compression (4 MB). Images above this threshold
    /// are JPEG-compressed, not rejected. Anthropic has a 5 MB limit per image;
    /// base64 encoding adds ~33% overhead, so 4 MB raw keeps us well within bounds.
    nonisolated static let maxImageSize = 4 * 1024 * 1024

    // MARK: - Error callback

    /// Called when an operation fails, so ChatViewModel can surface the error.
    public var onError: ((String) -> Void)?

    // MARK: - Error type

    private enum AttachmentError: Error {
        case message(String)
        var message: String {
            if case .message(let m) = self { return m }
            return "Unknown error."
        }
    }

    // MARK: - Public API

    public func addAttachment(url: URL) {
        // Move file reading, compression, and thumbnail generation off the main
        // thread — Data(contentsOf:) is a blocking syscall that can stall the UI.
        loadingCount += 1
        Task {
            defer { self.loadingCount -= 1 }
            let result = await self.loadAttachment(url: url)
            switch result {
            case .failure(let attachmentError):
                self.onError?(attachmentError.message)
            case .success(let attachment):
                self.pendingAttachments.append(attachment)
            }
        }
    }

    public func removeAttachment(id: String) {
        pendingAttachments.removeAll { $0.id == id }
    }

    public func addAttachmentFromPasteboard() {
        #if os(macOS)
        let pasteboard = NSPasteboard.general

        // Prefer file URLs — preserves the original filename
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL], !urls.isEmpty {
            for url in urls {
                addAttachment(url: url)
            }
            return
        }

        // Fall back to raw image data (e.g. screenshot to clipboard)
        guard let imageData = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) else {
            return
        }
        addAttachment(imageData: imageData, filename: "Pasted Image.png")
        #elseif os(iOS)
        let pasteboard = UIPasteboard.general
        guard let image = pasteboard.image, let imageData = image.pngData() else {
            return
        }
        addAttachment(imageData: imageData, filename: "Pasted Image.png")
        #else
        #error("Unsupported platform")
        #endif
    }

    /// Add an attachment from raw image data (e.g. drag-and-drop, pasteboard).
    /// Converts TIFF to PNG if needed.
    public func addAttachment(imageData: Data, filename: String = "Dropped Image.png") {
        // Move image conversion, compression, and thumbnail generation off the
        // main thread — these are CPU-bound and can take tens of milliseconds
        // for large images.
        loadingCount += 1
        Task {
            defer { self.loadingCount -= 1 }
            let result = await self.loadAttachment(imageData: imageData, filename: filename)
            switch result {
            case .failure(let attachmentError):
                self.onError?(attachmentError.message)
            case .success(let attachment):
                self.pendingAttachments.append(attachment)
            }
        }
    }

    // MARK: - Private background helpers

    /// Reads, compresses, and thumbnails an attachment from a file URL.
    /// All blocking work runs off the main actor; callers receive a ready-to-use
    /// ChatAttachment (or an error message) and can update UI state directly.
    private func loadAttachment(url: URL) async -> Result<ChatAttachment, AttachmentError> {
        // Suspend (not block) until a concurrency slot is available.
        await loadSemaphore.wait()
        // Hop off the main actor for all blocking I/O and CPU work.
        let result = await Task.detached(priority: .userInitiated) {
            // Pre-read size check to avoid loading huge files into memory.
            if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
               let fileSize = attrs[.size] as? Int,
               fileSize > Self.memorySafetyLimit {
                let sizeMB = fileSize / (1024 * 1024)
                return Result<ChatAttachment, AttachmentError>.failure(.message("This file is \(sizeMB) MB which is too large to process safely. Please choose a smaller file."))
            }

            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                log.error("Failed to read attachment: \(error.localizedDescription)")
                return Result<ChatAttachment, AttachmentError>.failure(.message("Could not read file."))
            }

            let filename = url.lastPathComponent
            var mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"

            // Compress images if needed
            var finalData = data
            var wasCompressed = false
            if let utType = UTType(filenameExtension: url.pathExtension), utType.conforms(to: .image) {
                let (compressedData, didCompress) = Self.compressImageIfNeeded(data: data, maxSize: Self.maxImageSize)
                finalData = compressedData
                wasCompressed = didCompress

                // Update MIME type if compression changed format
                if wasCompressed && finalData.count < data.count {
                    // Detect format from magic bytes
                    let header = [UInt8](finalData.prefix(4))
                    if header[0] == 0xFF && header[1] == 0xD8 {
                        mimeType = "image/jpeg"
                    } else if header == [0x89, 0x50, 0x4E, 0x47] {
                        mimeType = "image/png"
                    }
                }
            }

            let base64 = finalData.base64EncodedString()

            var thumbnail: Data?
            if let utType = UTType(filenameExtension: url.pathExtension), utType.conforms(to: .image) {
                thumbnail = Self.generateThumbnail(from: finalData, maxDimension: 120)
            }

            if wasCompressed {
                let originalMB = Double(data.count) / (1024 * 1024)
                let compressedMB = Double(finalData.count) / (1024 * 1024)
                log.info("Image compressed: \(String(format: "%.1f", originalMB))MB → \(String(format: "%.1f", compressedMB))MB")
            }

            #if os(macOS)
            let thumbnailImage = thumbnail.flatMap { NSImage(data: $0) }
            #elseif os(iOS)
            let thumbnailImage = thumbnail.flatMap { UIImage(data: $0) }
            #else
            #error("Unsupported platform")
            #endif

            let attachment = ChatAttachment(
                id: UUID().uuidString,
                filename: filename,
                mimeType: mimeType,
                data: base64,
                thumbnailData: thumbnail,
                dataLength: base64.count,
                thumbnailImage: thumbnailImage
            )
            return .success(attachment)
        }.value
        await loadSemaphore.signal()
        return result
    }

    /// Converts, validates, compresses, and thumbnails an attachment from raw image data.
    /// All blocking work runs off the main actor.
    private func loadAttachment(imageData: Data, filename: String) async -> Result<ChatAttachment, AttachmentError> {
        // Suspend (not block) until a concurrency slot is available.
        await loadSemaphore.wait()
        let result = await Task.detached(priority: .userInitiated) {
            // Convert to PNG if needed — raw image data may be TIFF
            let pngData: Data
            #if os(macOS)
            if let _ = NSImage(data: imageData) {
                // Check if already PNG by looking at magic bytes
                let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
                let headerBytes = [UInt8](imageData.prefix(4))
                if headerBytes == pngMagic {
                    pngData = imageData
                } else if let bitmapRep = NSBitmapImageRep(data: imageData),
                          let converted = bitmapRep.representation(using: .png, properties: [:]) {
                    pngData = converted
                } else {
                    log.error("Failed to convert dropped image to PNG")
                    return Result<ChatAttachment, AttachmentError>.failure(.message("Could not process image."))
                }
            } else {
                log.error("Dropped data is not a valid image")
                return Result<ChatAttachment, AttachmentError>.failure(.message("Could not process image."))
            }
            #elseif os(iOS)
            if let image = UIImage(data: imageData) {
                // Check if already PNG by looking at magic bytes
                let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
                let headerBytes = [UInt8](imageData.prefix(4))
                if headerBytes == pngMagic {
                    pngData = imageData
                } else if let converted = image.pngData() {
                    pngData = converted
                } else {
                    log.error("Failed to convert dropped image to PNG")
                    return Result<ChatAttachment, AttachmentError>.failure(.message("Could not process image."))
                }
            } else {
                log.error("Dropped data is not a valid image")
                return Result<ChatAttachment, AttachmentError>.failure(.message("Could not process image."))
            }
            #else
            #error("Unsupported platform")
            #endif

            // Memory safety guard for pasted/dropped images
            if pngData.count > Self.memorySafetyLimit {
                let sizeMB = pngData.count / (1024 * 1024)
                return .failure(.message("This image is \(sizeMB) MB which is too large to process safely. Please choose a smaller image."))
            }

            // Compress image if needed
            let (finalData, wasCompressed) = Self.compressImageIfNeeded(data: pngData, maxSize: Self.maxImageSize)

            if wasCompressed {
                let originalMB = Double(pngData.count) / (1024 * 1024)
                let compressedMB = Double(finalData.count) / (1024 * 1024)
                log.info("Image compressed: \(String(format: "%.1f", originalMB))MB → \(String(format: "%.1f", compressedMB))MB")
            }

            let base64 = finalData.base64EncodedString()
            let thumbnail = Self.generateThumbnail(from: finalData, maxDimension: 120)

            // Detect MIME type from compressed data
            var mimeType = "image/png"
            if wasCompressed {
                let header = [UInt8](finalData.prefix(4))
                if header[0] == 0xFF && header[1] == 0xD8 {
                    mimeType = "image/jpeg"
                }
            }

            #if os(macOS)
            let thumbnailImage = thumbnail.flatMap { NSImage(data: $0) }
            #elseif os(iOS)
            let thumbnailImage = thumbnail.flatMap { UIImage(data: $0) }
            #else
            #error("Unsupported platform")
            #endif

            let attachment = ChatAttachment(
                id: UUID().uuidString,
                filename: filename,
                mimeType: mimeType,
                data: base64,
                thumbnailData: thumbnail,
                dataLength: base64.count,
                thumbnailImage: thumbnailImage
            )
            return .success(attachment)
        }.value
        await loadSemaphore.signal()
        return result
    }

    // MARK: - Static helpers (shared with ChatViewModel+Attachments and mapMessageAttachments)

    /// Resize image data to fit within `maxDimension` and return PNG data.
    nonisolated public static func generateThumbnail(from data: Data, maxDimension: CGFloat) -> Data? {
        #if os(macOS)
        guard let image = NSImage(data: data) else { return nil }
        let size = image.size
        guard size.width > 0 && size.height > 0 else { return nil }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        let newSize = NSSize(width: size.width * scale, height: size.height * scale)
        // NSImage.lockFocus()/draw()/unlockFocus() must run on the main thread.
        // This helper is called from two contexts:
        //   1. Task.detached (background) — must hop to main via DispatchQueue.main.sync.
        //   2. @MainActor callers (e.g. ChatViewModel.mapMessageAttachments) — already on the
        //      main thread, so DispatchQueue.main.sync would deadlock. Execute inline.
        let drawBlock = {
            let resized = NSImage(size: newSize)
            resized.lockFocus()
            image.draw(in: NSRect(origin: .zero, size: newSize),
                       from: NSRect(origin: .zero, size: size),
                       operation: .copy, fraction: 1.0)
            resized.unlockFocus()
            return resized.tiffRepresentation
        }
        let tiffData: Data? = Thread.isMainThread ? drawBlock() : DispatchQueue.main.sync(execute: drawBlock)
        guard let tiffData,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
        return png
        #elseif os(iOS)
        guard let image = UIImage(data: data) else { return nil }
        let size = image.size
        guard size.width > 0 && size.height > 0 else { return nil }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        UIGraphicsBeginImageContextWithOptions(newSize, false, 0.0)
        image.draw(in: CGRect(origin: .zero, size: newSize))
        let resized = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()
        return resized?.pngData()
        #else
        #error("Unsupported platform")
        #endif
    }

    /// Compress image data if it exceeds the size limit.
    /// Returns (compressedData, wasCompressed) tuple.
    nonisolated public static func compressImageIfNeeded(data: Data, maxSize: Int) -> (Data, Bool) {
        // Check if compression is needed
        guard data.count > maxSize else {
            return (data, false)
        }

        #if os(macOS)
        // Only NSImage/NSBitmapImageRep calls need the main thread; keep
        // the CPU-heavy CGContext resize and encoding work off it.

        // Step 1 (AppKit – main thread): extract a CGImage from the raw data.
        let extractBlock = { () -> CGImage? in
            guard let image = NSImage(data: data) else { return nil }
            return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        }
        guard let cgImage = Thread.isMainThread ? extractBlock() : DispatchQueue.main.sync(execute: extractBlock) else {
            return (data, false)
        }

        let originalWidth = CGFloat(cgImage.width)
        let originalHeight = CGFloat(cgImage.height)
        guard originalWidth > 0 && originalHeight > 0 else {
            return (data, false)
        }

        // Step 2 (background): CoreGraphics resize – no AppKit required.
        let sizeReduction = Double(maxSize) / Double(data.count)
        let pixelReduction = sqrt(sizeReduction * 0.85) // Target 85% of max for safety margin
        let scale = min(CGFloat(pixelReduction), 1.0)

        let newWidth = Int(originalWidth * scale)
        let newHeight = Int(originalHeight * scale)

        guard let colorSpace = cgImage.colorSpace,
              let context = CGContext(
                data: nil,
                width: newWidth,
                height: newHeight,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            return (data, false)
        }

        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: newWidth, height: newHeight))

        guard let scaledCGImage = context.makeImage() else {
            return (data, false)
        }

        // Step 3 (AppKit – main thread): encode the scaled CGImage via
        // NSImage/NSBitmapImageRep (tiffRepresentation is not thread-safe).
        let encodeBlock = { () -> (Data, Bool) in
            let scaledImage = NSImage(cgImage: scaledCGImage, size: NSSize(width: newWidth, height: newHeight))

            // Try JPEG compression first (better for photos)
            if let tiffData = scaledImage.tiffRepresentation,
               let bitmap = NSBitmapImageRep(data: tiffData),
               let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.75]) {
                if jpeg.count <= maxSize {
                    log.info("Compressed image from \(data.count) to \(jpeg.count) bytes (JPEG, \(newWidth)×\(newHeight))")
                    return (jpeg, true)
                }
            }

            // Fallback: try PNG
            if let tiffData = scaledImage.tiffRepresentation,
               let bitmap = NSBitmapImageRep(data: tiffData),
               let png = bitmap.representation(using: .png, properties: [:]) {
                if png.count <= maxSize {
                    log.info("Compressed image from \(data.count) to \(png.count) bytes (PNG, \(newWidth)×\(newHeight))")
                    return (png, true)
                }
            }

            log.warning("Failed to compress image to \(maxSize) bytes, final size: \(data.count)")
            return (data, false)
        }
        return Thread.isMainThread ? encodeBlock() : DispatchQueue.main.sync(execute: encodeBlock)

        #elseif os(iOS)
        guard let image = UIImage(data: data) else {
            return (data, false)
        }

        let originalSize = image.size
        guard originalSize.width > 0 && originalSize.height > 0 else {
            return (data, false)
        }

        let sizeReduction = Double(maxSize) / Double(data.count)
        let pixelReduction = sqrt(sizeReduction * 0.85)
        let scale = min(CGFloat(pixelReduction), 1.0)

        let newSize = CGSize(
            width: originalSize.width * scale,
            height: originalSize.height * scale
        )

        UIGraphicsBeginImageContextWithOptions(newSize, false, 0.0)
        image.draw(in: CGRect(origin: .zero, size: newSize))
        let resized = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()

        guard let resized = resized else {
            return (data, false)
        }

        if let jpeg = resized.jpegData(compressionQuality: 0.75) {
            if jpeg.count <= maxSize {
                let dimensions = "\(Int(newSize.width))×\(Int(newSize.height))"
                log.info("Compressed image from \(data.count) to \(jpeg.count) bytes (JPEG, \(dimensions))")
                return (jpeg, true)
            }
        }

        if let png = resized.pngData() {
            if png.count <= maxSize {
                let dimensions = "\(Int(newSize.width))×\(Int(newSize.height))"
                log.info("Compressed image from \(data.count) to \(png.count) bytes (PNG, \(dimensions))")
                return (png, true)
            }
        }

        log.warning("Failed to compress image to \(maxSize) bytes, final size: \(data.count)")
        return (data, false)
        #else
        #error("Unsupported platform")
        #endif
    }
}
