import Combine
import Foundation
import ImageIO
import os
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ChatAttachmentManager")

/// Async-compatible semaphore that suspends (not blocks) waiting tasks.
/// Drop-in replacement for DispatchSemaphore in structured concurrency contexts,
/// avoiding thread starvation on the cooperative thread pool.
///
/// Cancellation-safe: if a waiting task is cancelled, its continuation is
/// removed from the queue and resumed with `false` (no slot consumed).
private actor AsyncSemaphore {
    private var count: Int
    private var nextID: UInt64 = 0
    private var waiters: [(id: UInt64, continuation: CheckedContinuation<Bool, Never>)] = []

    init(value: Int) { self.count = value }

    /// Waits for a slot. Returns `true` if a slot was acquired, `false` if the
    /// task was cancelled while waiting (no slot consumed). The caller must only
    /// call `signal()` when this returns `true`.
    func wait() async -> Bool {
        if count > 0 { count -= 1; return true }
        let id = nextID
        nextID += 1
        let acquired = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                waiters.append((id: id, continuation: continuation))
            }
        } onCancel: {
            Task { await self.cancelWaiter(id: id) }
        }
        return acquired
    }

    /// Removes a cancelled waiter from the queue (no slot consumed → resumes
    /// with `false`). If signal() already resumed this waiter (slot consumed →
    /// resumed with `true`), does nothing.
    private func cancelWaiter(id: UInt64) {
        if let idx = waiters.firstIndex(where: { $0.id == id }) {
            let removed = waiters.remove(at: idx)
            removed.continuation.resume(returning: false)
        }
    }

    func signal() {
        if let waiter = waiters.first {
            waiters.removeFirst()
            waiter.continuation.resume(returning: true)
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
@Observable
public final class ChatAttachmentManager {

    public var pendingAttachments: [ChatAttachment] = []
    /// True while at least one attachment is being loaded in the background.
    /// The send button checks this so a user can't send before async load finishes.
    public var isLoadingAttachment: Bool = false {
        didSet {
            isLoadingAttachmentSubject.send(isLoadingAttachment)
        }
    }

    // MARK: - Combine compatibility

    /// Combine bridge for `isLoadingAttachment`, consumed by
    /// `AppDelegate+InputMonitors` to wait for attachment loading before sending.
    private let isLoadingAttachmentSubject = CurrentValueSubject<Bool, Never>(false)
    public var isLoadingAttachmentPublisher: AnyPublisher<Bool, Never> {
        isLoadingAttachmentSubject.eraseToAnyPublisher()
    }

    // Counts in-flight background loads; isLoadingAttachment is true when > 0.
    // Not observed by views — only drives `isLoadingAttachment` via didSet.
    @ObservationIgnored private var loadingCount: Int = 0 {
        didSet { isLoadingAttachment = loadingCount > 0 }
    }

    /// Increment the loading count from an external source (e.g. drag-and-drop
    /// that needs immediate feedback before NSItemProvider async loads resolve).
    /// Must be balanced by a call to `endExternalLoad()`.
    public func beginExternalLoad() {
        loadingCount += 1
    }

    /// Decrement the loading count after an external load completes or the
    /// actual `addAttachment` call takes over tracking.
    public func endExternalLoad() {
        loadingCount = max(loadingCount - 1, 0)
    }

    /// Limits concurrent attachment I/O to keep memory usage reasonable.
    private static let maxConcurrentLoads = 2
    private let loadSemaphore = AsyncSemaphore(value: maxConcurrentLoads)

    /// Memory safety limit to avoid OOM from loading extremely large files.
    /// This is NOT a business rule — the server enforces its own size limits.
    nonisolated private static var memorySafetyLimit: Int { 100 * 1024 * 1024 }

    /// Maximum image size before compression (4 MB). Images above this threshold
    /// are JPEG-compressed, not rejected. The Anthropic API has a 5 MB per-image
    /// limit; 4 MB provides a comfortable safety margin.
    nonisolated static var maxImageSize: Int { 4 * 1024 * 1024 }

    // MARK: - Error callback

    /// Called when an operation fails, so ChatViewModel can surface the error.
    @ObservationIgnored public var onError: ((String) -> Void)?

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

    /// Intermediate result from the detached background task, containing only
    /// thread-safe value types. Platform image types (NSImage/UIImage) are
    /// constructed on the @MainActor after the task completes.
    private struct ProcessedAttachmentData {
        let id: String
        let filename: String
        let mimeType: String
        let base64: String
        let thumbnailData: Data?
        let dataLength: Int
        let filePath: String?
        /// Original file size in bytes. Set for file-backed attachments where
        /// base64 encoding is skipped.
        let originalFileSize: Int?
    }

    /// Reads, compresses, and thumbnails an attachment from a file URL.
    /// All blocking work runs off the main actor; platform image construction
    /// happens back on @MainActor where it is safe.
    private func loadAttachment(url: URL) async -> Result<ChatAttachment, AttachmentError> {
        let attachmentId = UUID().uuidString
        let filename = url.lastPathComponent
        log.debug("[Attachment] readStart id=\(attachmentId) source=fileURL filename=\(filename)")
        let acquired = await loadSemaphore.wait()
        guard acquired else { return .failure(.message("Attachment load cancelled.")) }
        // Resolve connection mode before entering the detached task so the
        // file-backed upload optimisation is only used when the assistant is
        // running locally and can read the file from disk.
        let useFileBackedUpload = (try? GatewayHTTPClient.isConnectionManaged()) != true
        let taskResult: Result<ProcessedAttachmentData, AttachmentError> = await Task.detached(priority: .userInitiated) {
            let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true

            // Check file size from attributes before reading data.
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
                  let fileSize = attrs[.size] as? Int else {
                log.error("[Attachment] failed id=\(attachmentId) reason=statError")
                return .failure(.message("Could not read file."))
            }
            if fileSize > Self.memorySafetyLimit {
                let sizeMB = fileSize / (1024 * 1024)
                log.error("[Attachment] failed id=\(attachmentId) reason=fileTooLarge sizeMB=\(sizeMB)")
                return .failure(.message("This file is \(sizeMB) MB which is too large to process safely. Please choose a smaller file."))
            }

            // For non-image files on a local connection, use file-backed upload:
            // skip reading the file into memory entirely. The assistant reads the
            // file directly from disk, avoiding the 33% base64 overhead and the
            // large HTTP body that can hit cloud proxy limits.
            //
            // In managed mode the assistant runs in a remote container that
            // cannot access the client's local filesystem, so we fall back to
            // reading the file and base64-encoding it inline.
            if !isImage && useFileBackedUpload {
                log.info("[Attachment] using file-backed upload id=\(attachmentId) sizeBytes=\(fileSize)")
                return .success(ProcessedAttachmentData(
                    id: attachmentId,
                    filename: filename,
                    mimeType: mimeType,
                    base64: "",
                    thumbnailData: nil,
                    dataLength: 0,
                    filePath: url.path,
                    originalFileSize: fileSize
                ))
            }

            // Read the file data for inline base64 encoding.
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                log.error("[Attachment] failed id=\(attachmentId) reason=readError error=\(error.localizedDescription)")
                return .failure(.message("Could not read file."))
            }

            let finalData: Data
            var finalMimeType = mimeType
            let thumbnail: Data?

            if isImage {
                let (compressedData, wasCompressed) = Self.compressImageIfNeeded(data: data, maxSize: Self.maxImageSize)
                finalData = compressedData

                if wasCompressed && finalData.count < data.count {
                    let header = [UInt8](finalData.prefix(4))
                    if header[0] == 0xFF && header[1] == 0xD8 {
                        finalMimeType = "image/jpeg"
                    } else if header == [0x89, 0x50, 0x4E, 0x47] {
                        finalMimeType = "image/png"
                    }
                    let originalMB = Double(data.count) / (1024 * 1024)
                    let compressedMB = Double(finalData.count) / (1024 * 1024)
                    log.info("Image compressed: \(String(format: "%.1f", originalMB))MB → \(String(format: "%.1f", compressedMB))MB")
                }

                thumbnail = Self.generateThumbnail(from: finalData, maxDimension: 800)
            } else {
                finalData = data
                thumbnail = nil
            }

            log.debug("[Attachment] normalized id=\(attachmentId) mimeType=\(finalMimeType) originalBytes=\(data.count) finalBytes=\(finalData.count)")

            let base64 = finalData.base64EncodedString()

            return .success(ProcessedAttachmentData(
                id: attachmentId,
                filename: filename,
                mimeType: finalMimeType,
                base64: base64,
                thumbnailData: thumbnail,
                dataLength: base64.count,
                filePath: url.path,
                originalFileSize: nil
            ))
        }.value
        Task { await loadSemaphore.signal() }

        switch taskResult {
        case .failure(let error):
            return .failure(error)
        case .success(let processed):
            #if os(macOS)
            let thumbnailImage = processed.thumbnailData.flatMap { NSImage(data: $0) }
            #elseif os(iOS)
            let thumbnailImage = processed.thumbnailData.flatMap { UIImage(data: $0) }
            #else
            #error("Unsupported platform")
            #endif
            return .success(ChatAttachment(
                id: processed.id,
                filename: processed.filename,
                mimeType: processed.mimeType,
                data: processed.base64,
                thumbnailData: processed.thumbnailData,
                dataLength: processed.dataLength,
                sizeBytes: processed.originalFileSize,
                thumbnailImage: thumbnailImage,
                filePath: processed.filePath
            ))
        }
    }

    /// Converts, validates, compresses, and thumbnails an attachment from raw image data.
    /// All blocking work (ImageIO decode/encode, compression) runs off the main actor;
    /// platform image construction happens back on @MainActor where it is safe.
    private func loadAttachment(imageData: Data, filename: String) async -> Result<ChatAttachment, AttachmentError> {
        let attachmentId = UUID().uuidString
        log.debug("[Attachment] readStart id=\(attachmentId) source=imageData filename=\(filename) rawBytes=\(imageData.count)")
        let acquired = await loadSemaphore.wait()
        guard acquired else { return .failure(.message("Attachment load cancelled.")) }
        let taskResult: Result<ProcessedAttachmentData, AttachmentError> = await Task.detached(priority: .userInitiated) {
            // Validate that ImageIO can decode the data.
            guard Self.loadCGImage(from: imageData) != nil else {
                log.error("[Attachment] failed id=\(attachmentId) reason=invalidImageData")
                return .failure(.message("Could not process image."))
            }

            // Convert to PNG if needed — raw image data may be TIFF, HEIC, etc.
            let pngData: Data
            let pngMagic: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
            let headerBytes = [UInt8](imageData.prefix(4))
            if headerBytes == pngMagic {
                pngData = imageData
            } else if let cgImage = Self.loadCGImage(from: imageData),
                      let converted = Self.encodeCGImage(cgImage, type: .png) {
                pngData = converted
            } else {
                log.error("[Attachment] failed id=\(attachmentId) reason=pngConversionFailed")
                return .failure(.message("Could not process image."))
            }

            // Memory safety guard for pasted/dropped images
            if pngData.count > Self.memorySafetyLimit {
                let sizeMB = pngData.count / (1024 * 1024)
                log.error("[Attachment] failed id=\(attachmentId) reason=imageTooLarge sizeMB=\(sizeMB)")
                return .failure(.message("This image is \(sizeMB) MB which is too large to process safely. Please choose a smaller image."))
            }

            let (finalData, wasCompressed) = Self.compressImageIfNeeded(data: pngData, maxSize: Self.maxImageSize)

            if wasCompressed {
                let originalMB = Double(pngData.count) / (1024 * 1024)
                let compressedMB = Double(finalData.count) / (1024 * 1024)
                log.info("Image compressed: \(String(format: "%.1f", originalMB))MB → \(String(format: "%.1f", compressedMB))MB")
            }

            var mimeType = "image/png"
            if wasCompressed {
                let header = [UInt8](finalData.prefix(4))
                if header[0] == 0xFF && header[1] == 0xD8 {
                    mimeType = "image/jpeg"
                }
            }

            log.debug("[Attachment] normalized id=\(attachmentId) mimeType=\(mimeType) originalBytes=\(pngData.count) finalBytes=\(finalData.count) compressed=\(wasCompressed)")

            let base64 = finalData.base64EncodedString()
            let thumbnail = Self.generateThumbnail(from: finalData, maxDimension: 800)

            return .success(ProcessedAttachmentData(
                id: attachmentId,
                filename: filename,
                mimeType: mimeType,
                base64: base64,
                thumbnailData: thumbnail,
                dataLength: base64.count,
                filePath: nil,
                originalFileSize: nil
            ))
        }.value
        Task { await loadSemaphore.signal() }

        switch taskResult {
        case .failure(let error):
            return .failure(error)
        case .success(let processed):
            #if os(macOS)
            let thumbnailImage = processed.thumbnailData.flatMap { NSImage(data: $0) }
            #elseif os(iOS)
            let thumbnailImage = processed.thumbnailData.flatMap { UIImage(data: $0) }
            #else
            #error("Unsupported platform")
            #endif
            return .success(ChatAttachment(
                id: processed.id,
                filename: processed.filename,
                mimeType: processed.mimeType,
                data: processed.base64,
                thumbnailData: processed.thumbnailData,
                dataLength: processed.dataLength,
                thumbnailImage: thumbnailImage
            ))
        }
    }

    // MARK: - Thread-safe ImageIO helpers

    /// Decode a CGImage from raw data via ImageIO with EXIF orientation applied.
    /// Uses CGImageSourceCreateThumbnailAtIndex at full resolution so the returned
    /// pixel buffer has the correct orientation baked in (e.g. portrait photos from
    /// cameras are already rotated). Thread-safe, works on any thread.
    nonisolated private static func loadCGImage(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        // Read the raw pixel dimensions to request a "thumbnail" at full size.
        let maxDimension: Int
        if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let pixelWidth = properties[kCGImagePropertyPixelWidth] as? Int,
           let pixelHeight = properties[kCGImagePropertyPixelHeight] as? Int {
            maxDimension = max(pixelWidth, pixelHeight)
        } else {
            // Dimensions unavailable (malformed image); use a large cap so
            // CGImageSourceCreateThumbnailAtIndex still applies the EXIF transform.
            maxDimension = 100_000
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// Encode a CGImage to JPEG or PNG via ImageIO. Thread-safe, works on any thread.
    nonisolated private static func encodeCGImage(
        _ cgImage: CGImage,
        type: UTType,
        quality: CGFloat? = nil
    ) -> Data? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data as CFMutableData,
            type.identifier as CFString,
            1,
            nil
        ) else { return nil }
        var options: [CFString: Any] = [:]
        if let quality {
            options[kCGImageDestinationLossyCompressionQuality] = quality
        }
        CGImageDestinationAddImage(dest, cgImage, options.isEmpty ? nil : options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    // MARK: - Static helpers (shared with ChatViewModel+Attachments and mapMessageAttachments)

    /// Resize image data to fit within `maxDimension` and return PNG data.
    /// Uses CGImageSourceCreateThumbnailAtIndex for efficient subsampled decoding
    /// (only reads the pixels needed for the target size, ~30x faster than full decode).
    /// Thread-safe — no main thread hop required.
    nonisolated public static func generateThumbnail(from data: Data, maxDimension: CGFloat) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension
        ]
        guard let cgThumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return encodeCGImage(cgThumb, type: .png)
    }

    /// Compress image data if it exceeds the size limit.
    /// Returns (compressedData, wasCompressed) tuple.
    ///
    /// Strategy: try JPEG quality reduction first (preserves full resolution),
    /// then fall back to pixel downscaling only if quality alone can't hit the target.
    /// Thread-safe — uses ImageIO for decoding/encoding and CGContext for resizing.
    nonisolated public static func compressImageIfNeeded(data: Data, maxSize: Int) -> (Data, Bool) {
        guard data.count > maxSize else {
            return (data, false)
        }

        // Step 1: Decode via ImageIO (thread-safe, no platform UI types needed).
        guard let cgImage = loadCGImage(from: data) else {
            return (data, false)
        }

        let originalWidth = cgImage.width
        let originalHeight = cgImage.height
        guard originalWidth > 0 && originalHeight > 0 else {
            return (data, false)
        }

        // Step 2: Try JPEG quality reduction at full resolution first.
        // Many oversized images (especially JPEGs) can fit within the limit
        // with quality reduction alone, preserving full pixel resolution.
        let qualitySteps: [CGFloat] = [0.85, 0.75, 0.65, 0.5]
        for quality in qualitySteps {
            if let jpeg = encodeCGImage(cgImage, type: .jpeg, quality: quality),
               jpeg.count <= maxSize {
                log.info("Compressed image from \(data.count) to \(jpeg.count) bytes (JPEG q\(quality), \(originalWidth)×\(originalHeight))")
                return (jpeg, true)
            }
        }

        // Step 3: Quality reduction alone wasn't enough — downscale pixels.
        // Use the file size from the best quality-only attempt (q=0.5) to
        // estimate how much pixel reduction is still needed, rather than
        // basing the estimate on the original file size which ignores the
        // compression already provided by JPEG encoding.
        let referenceSize: Int
        if let jpeg50 = encodeCGImage(cgImage, type: .jpeg, quality: 0.5) {
            referenceSize = jpeg50.count
        } else {
            referenceSize = data.count
        }

        let sizeReduction = Double(maxSize) / Double(referenceSize)
        // sqrt because pixel reduction applies to both dimensions
        let scale = min(CGFloat(sqrt(sizeReduction * 0.9)), 1.0)

        let newWidth = max(Int(CGFloat(originalWidth) * scale), 1)
        let newHeight = max(Int(CGFloat(originalHeight) * scale), 1)

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

        // Step 4: Encode the downscaled image, trying progressively lower quality.
        for quality in qualitySteps {
            if let jpeg = encodeCGImage(scaledCGImage, type: .jpeg, quality: quality),
               jpeg.count <= maxSize {
                log.info("Compressed image from \(data.count) to \(jpeg.count) bytes (JPEG q\(quality), \(newWidth)×\(newHeight))")
                return (jpeg, true)
            }
        }

        // Last resort: PNG of the downscaled image.
        if let png = encodeCGImage(scaledCGImage, type: .png),
           png.count <= maxSize {
            log.info("Compressed image from \(data.count) to \(png.count) bytes (PNG, \(newWidth)×\(newHeight))")
            return (png, true)
        }

        log.warning("Failed to compress image to \(maxSize) bytes, final size: \(data.count)")
        return (data, false)
    }
}
