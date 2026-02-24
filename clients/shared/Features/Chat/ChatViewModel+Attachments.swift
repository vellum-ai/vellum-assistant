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

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatViewModel+Attachments")

// MARK: - Attachments

extension ChatViewModel {

    public func addAttachment(url: URL) {
        guard pendingAttachments.count < Self.maxAttachments else {
            errorText = "Maximum \(Self.maxAttachments) attachments per message."
            return
        }

        // Check file size via metadata before reading into memory to avoid
        // loading very large files synchronously (which could freeze the UI).
        do {
            let resourceValues = try url.resourceValues(forKeys: [.fileSizeKey])
            if let fileSize = resourceValues.fileSize, fileSize > Self.maxFileSize {
                errorText = "File exceeds 20 MB limit."
                return
            }
        } catch {
            log.error("Failed to read file attributes: \(error.localizedDescription)")
            errorText = "Could not read file."
            return
        }

        // Move file reading, compression, and thumbnail generation off the main
        // thread — Data(contentsOf:) is a blocking syscall that can stall the UI
        // for up to 20 MB worth of I/O before we even begin image processing.
        Task {
            let result = await Self.loadAttachment(url: url)
            switch result {
            case .failure(let attachmentError):
                self.errorText = attachmentError.message
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
        guard pendingAttachments.count < Self.maxAttachments else {
            errorText = "Maximum \(Self.maxAttachments) attachments per message."
            return
        }

        // Move image conversion, compression, and thumbnail generation off the
        // main thread — these are CPU-bound and can take tens of milliseconds
        // for large images.
        Task {
            let result = await Self.loadAttachment(imageData: imageData, filename: filename)
            switch result {
            case .failure(let attachmentError):
                self.errorText = attachmentError.message
            case .success(let attachment):
                self.pendingAttachments.append(attachment)
            }
        }
    }

    // MARK: - Private background helpers

    private enum AttachmentError {
        case message(String)
        var message: String {
            if case .message(let m) = self { return m }
            return "Unknown error."
        }
    }

    /// Reads, validates, compresses, and thumbnails an attachment from a file URL.
    /// All blocking work runs off the main actor; callers receive a ready-to-use
    /// ChatAttachment (or an error message) and can update UI state directly.
    private static func loadAttachment(url: URL) async -> Result<ChatAttachment, AttachmentError> {
        // Hop off the main actor for all blocking I/O and CPU work.
        return await Task.detached(priority: .userInitiated) {
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                log.error("Failed to read attachment: \(error.localizedDescription)")
                return .failure(.message("Could not read file."))
            }

            // Belt-and-suspenders: the pre-read metadata check above may report
            // nil (e.g. symlinks, certain file systems) so always validate the
            // actual byte count after reading.
            guard data.count <= Self.maxFileSize else {
                return .failure(.message("File exceeds 20 MB limit."))
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

            // Inform user if image was compressed
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
    }

    /// Converts, validates, compresses, and thumbnails an attachment from raw image data.
    /// All blocking work runs off the main actor.
    private static func loadAttachment(imageData: Data, filename: String) async -> Result<ChatAttachment, AttachmentError> {
        return await Task.detached(priority: .userInitiated) {
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
                    return .failure(.message("Could not process image."))
                }
            } else {
                log.error("Dropped data is not a valid image")
                return .failure(.message("Could not process image."))
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
                    return .failure(.message("Could not process image."))
                }
            } else {
                log.error("Dropped data is not a valid image")
                return .failure(.message("Could not process image."))
            }
            #else
            #error("Unsupported platform")
            #endif

            guard pngData.count <= Self.maxFileSize else {
                return .failure(.message("Image exceeds 20 MB limit."))
            }

            // Compress image if needed
            let (finalData, wasCompressed) = Self.compressImageIfNeeded(data: pngData, maxSize: Self.maxImageSize)

            // Inform user if image was compressed
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
    }

    // MARK: - Image processing utilities

    /// Resize image data to fit within `maxDimension` and return PNG data.
    static func generateThumbnail(from data: Data, maxDimension: CGFloat) -> Data? {
        #if os(macOS)
        guard let image = NSImage(data: data) else { return nil }
        let size = image.size
        guard size.width > 0 && size.height > 0 else { return nil }
        let scale = min(maxDimension / size.width, maxDimension / size.height, 1.0)
        let newSize = NSSize(width: size.width * scale, height: size.height * scale)
        let resized = NSImage(size: newSize)
        resized.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: newSize),
                   from: NSRect(origin: .zero, size: size),
                   operation: .copy, fraction: 1.0)
        resized.unlockFocus()
        guard let tiffData = resized.tiffRepresentation,
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
    static func compressImageIfNeeded(data: Data, maxSize: Int) -> (Data, Bool) {
        // Check if compression is needed
        guard data.count > maxSize else {
            return (data, false)
        }

        #if os(macOS)
        guard let image = NSImage(data: data),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            // Not a valid image, return as-is
            return (data, false)
        }

        let originalWidth = CGFloat(cgImage.width)
        let originalHeight = CGFloat(cgImage.height)
        guard originalWidth > 0 && originalHeight > 0 else {
            return (data, false)
        }

        // Calculate scale factor needed to reduce file size
        // Rough heuristic: file size scales roughly with pixel count
        let sizeReduction = Double(maxSize) / Double(data.count)
        let pixelReduction = sqrt(sizeReduction * 0.85) // Target 85% of max for safety margin
        let scale = min(CGFloat(pixelReduction), 1.0)

        let newWidth = Int(originalWidth * scale)
        let newHeight = Int(originalHeight * scale)

        // Create bitmap context for resizing
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

        // Draw scaled image
        context.interpolationQuality = .high
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: newWidth, height: newHeight))

        guard let scaledCGImage = context.makeImage() else {
            return (data, false)
        }

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

        // If still too large, warn and return original
        log.warning("Failed to compress image to \(maxSize) bytes, final size: \(data.count)")
        return (data, false)

        #elseif os(iOS)
        guard let image = UIImage(data: data) else {
            return (data, false)
        }

        let originalSize = image.size
        guard originalSize.width > 0 && originalSize.height > 0 else {
            return (data, false)
        }

        // Calculate scale factor
        let sizeReduction = Double(maxSize) / Double(data.count)
        let pixelReduction = sqrt(sizeReduction * 0.85) // Target 85% for safety margin
        let scale = min(CGFloat(pixelReduction), 1.0)

        let newSize = CGSize(
            width: originalSize.width * scale,
            height: originalSize.height * scale
        )

        // Resize image
        UIGraphicsBeginImageContextWithOptions(newSize, false, 0.0)
        image.draw(in: CGRect(origin: .zero, size: newSize))
        let resized = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()

        guard let resized = resized else {
            return (data, false)
        }

        // Try JPEG compression
        if let jpeg = resized.jpegData(compressionQuality: 0.75) {
            if jpeg.count <= maxSize {
                let dimensions = "\(Int(newSize.width))×\(Int(newSize.height))"
                log.info("Compressed image from \(data.count) to \(jpeg.count) bytes (JPEG, \(dimensions))")
                return (jpeg, true)
            }
        }

        // Fallback: try PNG
        if let png = resized.pngData() {
            if png.count <= maxSize {
                let dimensions = "\(Int(newSize.width))×\(Int(newSize.height))"
                log.info("Compressed image from \(data.count) to \(png.count) bytes (PNG, \(dimensions))")
                return (png, true)
            }
        }

        // If still too large, warn and return original
        log.warning("Failed to compress image to \(maxSize) bytes, final size: \(data.count)")
        return (data, false)
        #else
        #error("Unsupported platform")
        #endif
    }
}
