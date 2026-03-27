import AppKit
import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

// MARK: - Image Context Menu Actions

/// Standalone helper for image context menu actions used by both
/// `InlineToolCallImageView` and `AttachmentImageGrid`. Kept at file scope
/// so it is accessible from private structs without coupling to `ChatBubble`.
enum ImageActions {

    /// Copies the image to the system clipboard.
    /// Prefers full-resolution data decoded from `rawData` or `base64Data` when
    /// available, falling back to the provided (possibly thumbnail) NSImage.
    static func copyToClipboard(_ image: NSImage, base64Data: String? = nil, rawData: Data? = nil) {
        // Prefer full-res from raw or base64 data when available
        let imageToWrite: NSImage
        if let rawData, !rawData.isEmpty,
           let fullRes = NSImage(data: rawData) {
            imageToWrite = fullRes
        } else if let base64Data, !base64Data.isEmpty,
           let decoded = Data(base64Encoded: base64Data), !decoded.isEmpty,
           let fullRes = NSImage(data: decoded) {
            imageToWrite = fullRes
        } else {
            imageToWrite = image
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([imageToWrite])
    }

    /// Opens an NSSavePanel and writes the image to the chosen path.
    /// Prefers `rawData` or `base64Data` (full resolution) when available,
    /// falling back to PNG-encoding the in-memory NSImage.
    static func saveImageAs(_ image: NSImage, filename: String, base64Data: String? = nil, rawData: Data? = nil) {
        let sanitized = (filename as NSString).lastPathComponent
        let fallbackName = sanitized.isEmpty ? "image.png" : sanitized

        let hasFullData = (rawData != nil && !rawData!.isEmpty) || (base64Data.map { !$0.isEmpty } ?? false)
        let suggestedName: String
        if hasFullData {
            suggestedName = fallbackName
        } else {
            suggestedName = (fallbackName as NSString).deletingPathExtension + ".png"
        }

        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            // Determine data to write on the main thread.
            // tiffRepresentation is not thread-safe (see ChatAttachmentManager.swift)
            // so PNG encoding must happen here, not in a background queue.
            let dataToWrite: Data?
            if let rawData, !rawData.isEmpty {
                dataToWrite = rawData
            } else if let base64Data, !base64Data.isEmpty,
               let decoded = Data(base64Encoded: base64Data), !decoded.isEmpty {
                dataToWrite = decoded
            } else if let tiff = image.tiffRepresentation,
                      let rep = NSBitmapImageRep(data: tiff),
                      let png = rep.representation(using: .png, properties: [:]) {
                dataToWrite = png
            } else {
                dataToWrite = nil
            }
            guard let dataToWrite else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try dataToWrite.write(to: url)
                    DispatchQueue.main.async {
                        AppDelegate.shared?.mainWindow?.windowState.showToast(
                            message: "Saved to \(url.lastPathComponent)",
                            style: .success
                        )
                    }
                } catch {
                    // Write failed — no toast
                }
            }
        }
    }

    /// Writes the image to a temporary file and returns the file URL.
    /// Prefers `rawData`, then `base64Data` (full resolution), falling back to
    /// PNG-encoding the NSImage. Returns nil if the image could not be written.
    static func writeTempFile(_ image: NSImage, filename: String, base64Data: String? = nil, rawData: Data? = nil) -> URL? {
        let tempDir = FileManager.default.temporaryDirectory
        let sanitized = (filename as NSString).lastPathComponent
        let fallbackName = sanitized.isEmpty ? "image.png" : sanitized

        var usedPNGFallback = false
        let fileData: Data? = {
            if let rawData, !rawData.isEmpty {
                return rawData
            }
            if let base64Data, !base64Data.isEmpty,
               let decoded = Data(base64Encoded: base64Data), !decoded.isEmpty {
                return decoded
            }
            if let tiff = image.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff) {
                usedPNGFallback = true
                return rep.representation(using: .png, properties: [:])
            }
            return nil
        }()

        let fileName: String
        if usedPNGFallback {
            fileName = (fallbackName as NSString).deletingPathExtension + ".png"
        } else {
            fileName = fallbackName
        }
        let fileURL = tempDir.appendingPathComponent(fileName)

        guard let fileData else { return nil }
        do {
            try fileData.write(to: fileURL)
            return fileURL
        } catch {
            return nil
        }
    }

    /// Writes the image to a temporary file and opens it in the default app (Preview).
    static func openInPreview(_ image: NSImage, filename: String, base64Data: String? = nil, rawData: Data? = nil) {
        guard let fileURL = writeTempFile(image, filename: filename, base64Data: base64Data, rawData: rawData) else { return }
        NSWorkspace.shared.open(fileURL)
    }

    /// Maps a file extension to the corresponding `NSBitmapImageRep.FileType`
    /// so that probe files are encoded in the correct format for their extension.
    private static func bitmapFileType(for extension: String) -> NSBitmapImageRep.FileType {
        switch `extension`.lowercased() {
        case "jpg", "jpeg": return .jpeg
        case "gif": return .gif
        case "bmp": return .bmp
        case "tiff", "tif": return .tiff
        default: return .png
        }
    }

    /// Cache of sharing services by file extension. Services depend on file type,
    /// not content, so one discovery per extension per app session is sufficient.
    private static var sharingServicesCache: [String: [NSSharingService]] = [:]

    /// Returns cached sharing services for the given filename's extension.
    /// On first call per extension, writes a minimal valid image file and calls
    /// `NSSharingService.sharingServices(forItems:)` once, caching the result.
    /// A real (non-empty) probe file is used because some services validate
    /// media content and return fewer results for zero-byte placeholders.
    @available(macOS, deprecated: 13.0)
    private static func cachedSharingServices(for filename: String) -> [NSSharingService] {
        let ext = (filename as NSString).pathExtension.lowercased()
        let key = ext.isEmpty ? "png" : ext
        if let cached = sharingServicesCache[key] { return cached }
        let probeURL = FileManager.default.temporaryDirectory.appendingPathComponent("vellum-share-probe.\(key)")
        if !FileManager.default.fileExists(atPath: probeURL.path) {
            // Write a minimal 1x1 PNG so services that validate content see a real image.
            // NSImage(size:) without drawing produces no representations, so use
            // init(size:flipped:drawingHandler:) to create actual pixel data.
            let tiny = NSImage(size: NSSize(width: 1, height: 1), flipped: false) { _ in
                NSColor.clear.set()
                NSRect(x: 0, y: 0, width: 1, height: 1).fill()
                return true
            }
            if let tiff = tiny.tiffRepresentation,
               let rep = NSBitmapImageRep(data: tiff),
               let data = rep.representation(using: bitmapFileType(for: key), properties: [:]) {
                try? data.write(to: probeURL)
            } else {
                // Fallback: create the file with empty data so the path exists.
                FileManager.default.createFile(atPath: probeURL.path, contents: Data())
            }
        }
        let services = NSSharingService.sharingServices(forItems: [probeURL])
        sharingServicesCache[key] = services
        return services
    }

    /// Fetches full-res image data for a lazy-loaded attachment, falling back to nil on error.
    static func fetchLazyData(attachmentId: String?) async -> Data? {
        guard let attachmentId, !attachmentId.isEmpty else { return nil }
        return try? await AttachmentContentClient.fetchContent(attachmentId: attachmentId)
    }

    /// Builds a SwiftUI context menu with Copy, Save As, and Open in Preview actions.
    /// When `lazyAttachmentId` is provided and `base64Data` is nil, actions will
    /// fetch full-res data from the server on demand.
    @available(macOS, deprecated: 13.0)
    @ViewBuilder
    static func contextMenuItems(
        image: NSImage,
        filename: String,
        base64Data: String? = nil,
        lazyAttachmentId: String? = nil
    ) -> some View {
        Button {
            if base64Data != nil {
                copyToClipboard(image, base64Data: base64Data)
            } else if let lazyAttachmentId {
                Task {
                    let data = await fetchLazyData(attachmentId: lazyAttachmentId)
                    copyToClipboard(image, rawData: data)
                }
            } else {
                copyToClipboard(image)
            }
        } label: {
            Label { Text("Copy Image") } icon: { VIconView(.copy, size: 12) }
        }

        Button {
            if base64Data != nil {
                saveImageAs(image, filename: filename, base64Data: base64Data)
            } else if let lazyAttachmentId {
                Task {
                    let data = await fetchLazyData(attachmentId: lazyAttachmentId)
                    saveImageAs(image, filename: filename, rawData: data)
                }
            } else {
                saveImageAs(image, filename: filename)
            }
        } label: {
            Label { Text("Save Image As\u{2026}") } icon: { VIconView(.arrowDownToLine, size: 12) }
        }

        Button {
            if base64Data != nil {
                openInPreview(image, filename: filename, base64Data: base64Data)
            } else if let lazyAttachmentId {
                Task {
                    let data = await fetchLazyData(attachmentId: lazyAttachmentId)
                    openInPreview(image, filename: filename, rawData: data)
                }
            } else {
                openInPreview(image, filename: filename)
            }
        } label: {
            Label { Text("Open in Preview") } icon: { VIconView(.eye, size: 12) }
        }

        // Sharing services are cached per file extension to avoid synchronous
        // XPC roundtrips on every render. Temp file writes are deferred to
        // click time so the view builder stays fast.
        // NSSharingService.sharingServices is deprecated in macOS 13 but has
        // no functional replacement for custom share UI (see AppSharePanelView).
        // Silenced via @available on this method; see AppSharePanelView for the same pattern.
        let services = cachedSharingServices(for: filename)
        if !services.isEmpty {
            Divider()
            Menu {
                ForEach(Array(services.enumerated()), id: \.offset) { _, service in
                    Button {
                        if let lazyAttachmentId, base64Data == nil {
                            Task {
                                let data = await fetchLazyData(attachmentId: lazyAttachmentId)
                                let shareURL = writeTempFile(image, filename: filename, rawData: data)
                                    ?? writeTempFile(image, filename: filename)
                                let probeExt = (filename as NSString).pathExtension.lowercased()
                                let fallback = FileManager.default.temporaryDirectory
                                    .appendingPathComponent("vellum-share-probe.\(probeExt.isEmpty ? "png" : probeExt)")
                                service.perform(withItems: [shareURL ?? fallback])
                            }
                        } else {
                            // Write temp file at action time (not during render).
                            // Try full-res first, fall back to thumbnail, fall back to
                            // the probe file so the Share action is never a silent no-op.
                            let shareURL = writeTempFile(image, filename: filename, base64Data: base64Data)
                                ?? writeTempFile(image, filename: filename)
                            let probeExt = (filename as NSString).pathExtension.lowercased()
                            let fallback = FileManager.default.temporaryDirectory
                                .appendingPathComponent("vellum-share-probe.\(probeExt.isEmpty ? "png" : probeExt)")
                            service.perform(withItems: [shareURL ?? fallback])
                        }
                    } label: {
                        Label {
                            Text(service.title)
                        } icon: {
                            Image(nsImage: service.image)
                        }
                    }
                }
            } label: {
                Label { Text("Share") } icon: { VIconView(.share, size: 12) }
            }
        }

    }
}
