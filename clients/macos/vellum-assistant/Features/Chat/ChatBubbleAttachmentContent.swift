import AppKit
import SwiftUI
import UniformTypeIdentifiers
import VellumAssistantShared

/// Posted when an image drag begins from within the chat UI.
/// ChatView observes this to suppress the drop zone overlay for internal drags.
extension Notification.Name {
    static let internalImageDragStarted = Notification.Name("com.vellum.internalImageDragStarted")
}

// MARK: - Image Context Menu Actions

/// Standalone helper for image context menu actions used by both
/// `InlineToolCallImageView` and `AttachmentImageGrid`. Kept at file scope
/// so it is accessible from private structs without coupling to `ChatBubble`.
private enum ImageActions {

    /// Copies the image to the system clipboard.
    /// Prefers full-resolution data decoded from `base64Data` when available,
    /// falling back to the provided (possibly thumbnail) NSImage.
    static func copyToClipboard(_ image: NSImage, base64Data: String? = nil) {
        // Prefer full-res from base64 data when available
        let imageToWrite: NSImage
        if let base64Data, !base64Data.isEmpty,
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
    /// Prefers `base64Data` (full resolution) when available, falling back to
    /// PNG-encoding the in-memory NSImage.
    static func saveImageAs(_ image: NSImage, filename: String, base64Data: String? = nil) {
        let sanitized = (filename as NSString).lastPathComponent
        let fallbackName = sanitized.isEmpty ? "image.png" : sanitized

        // Use non-emptiness as a lightweight proxy for valid base64 data to
        // decide the suggested filename. Full decode is deferred to the
        // background write block to avoid blocking the main thread for large
        // payloads (multi-MB screenshots).
        let hasBase64 = base64Data.map { !$0.isEmpty } ?? false
        let suggestedName: String
        if hasBase64 {
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
            if let base64Data, !base64Data.isEmpty,
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
                try? dataToWrite.write(to: url)
            }
        }
    }

    /// Writes the image to a temporary file and returns the file URL.
    /// Prefers `base64Data` (full resolution), falling back to PNG-encoding the NSImage.
    /// Returns nil if the image could not be written.
    static func writeTempFile(_ image: NSImage, filename: String, base64Data: String? = nil) -> URL? {
        let tempDir = FileManager.default.temporaryDirectory
        let sanitized = (filename as NSString).lastPathComponent
        let fallbackName = sanitized.isEmpty ? "image.png" : sanitized

        var usedPNGFallback = false
        let fileData: Data? = {
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
    static func openInPreview(_ image: NSImage, filename: String, base64Data: String? = nil) {
        guard let fileURL = writeTempFile(image, filename: filename, base64Data: base64Data) else { return }
        NSWorkspace.shared.open(fileURL)
    }

    /// Builds a SwiftUI context menu with Copy, Save As, and Open in Preview actions.
    @available(macOS, deprecated: 13.0)
    @ViewBuilder
    static func contextMenuItems(
        image: NSImage,
        filename: String,
        base64Data: String? = nil
    ) -> some View {
        Button {
            copyToClipboard(image, base64Data: base64Data)
        } label: {
            Label { Text("Copy Image") } icon: { VIconView(.copy, size: 12) }
        }

        Button {
            saveImageAs(image, filename: filename, base64Data: base64Data)
        } label: {
            Label { Text("Save Image As\u{2026}") } icon: { VIconView(.arrowDownToLine, size: 12) }
        }

        Button {
            openInPreview(image, filename: filename, base64Data: base64Data)
        } label: {
            Label { Text("Open in Preview") } icon: { VIconView(.eye, size: 12) }
        }

        // Write a temp file for sharing — NSSharingService.sharingServices
        // returns far more services (AirDrop, Messages, Mail, etc.) when given
        // a file URL vs a raw NSImage. The temp file write is lightweight
        // (thumbnail image) to keep the view builder fast. Full-res file is
        // written at action time when the user picks a service.
        // NSSharingService.sharingServices is deprecated in macOS 13 but has
        // no functional replacement for custom share UI (see AppSharePanelView).
        // Silenced via @available on this method; see AppSharePanelView for the same pattern.
        if let tempURL = writeTempFile(image, filename: filename) {
            let services = NSSharingService.sharingServices(forItems: [tempURL])
            if !services.isEmpty {
                Divider()
                Menu {
                    ForEach(Array(services.enumerated()), id: \.offset) { _, service in
                        Button {
                            // Write full-res file at action time, then share
                            if let fullResURL = writeTempFile(image, filename: filename, base64Data: base64Data) {
                                service.perform(withItems: [fullResURL])
                            } else {
                                service.perform(withItems: [tempURL])
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
}

// MARK: - Inline Tool Call Image

/// Renders a single tool-call-generated image at full width in the message flow.
/// Uses `@Environment(\.displayScale)` for correct sizing on Retina and non-Retina displays.
private struct InlineToolCallImageView: View {
    let image: NSImage
    @Environment(\.displayScale) private var displayScale

    @available(macOS, deprecated: 13.0)
    var body: some View {
        imageContent
            .onTapGesture {
                ImageActions.openInPreview(image, filename: "image.png")
            }
            .contextMenu {
                ImageActions.contextMenuItems(image: image, filename: "image.png")
            }
            .onDrag {
                NotificationCenter.default.post(name: .internalImageDragStarted, object: nil)
                let provider = NSItemProvider()
                if let tiff = image.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let pngData = rep.representation(using: .png, properties: [:]) {
                    provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
                        completion(pngData, nil)
                        return nil
                    }
                }
                provider.suggestedName = "image"
                return provider
            }
            .pointerCursor()
    }

    @ViewBuilder
    private var imageContent: some View {
        if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            let nativeWidth = CGFloat(cgImage.width) / displayScale
            let nativeHeight = CGFloat(cgImage.height) / displayScale
            let maxDim: CGFloat = VSpacing.chatBubbleMaxWidth
            Image(decorative: cgImage, scale: displayScale)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(
                    maxWidth: min(nativeWidth, maxDim),
                    maxHeight: min(nativeHeight, maxDim)
                )
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        } else {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }
}

// MARK: - Attachment Image Grid (async)

/// Renders image attachments in a horizontal grid.
///
/// NSImage(data:) must never be called during SwiftUI view body evaluation or
/// layout measurement — doing so triggers re-entrant AppKit constraint
/// invalidation that causes EXC_BAD_ACCESS when scrolling. This view decodes
/// images asynchronously via .task so the layout path only ever sees
/// pre-decoded NSImage values or a placeholder.
private struct AttachmentImageGrid<Fallback: View>: View {
    let imageAttachments: [ChatAttachment]
    let onTap: (ChatAttachment, NSImage) -> Void
    /// Rendered in place of the gray placeholder when all decode paths fail for an attachment.
    @ViewBuilder let fallback: (ChatAttachment) -> Fallback

    @State private var loadedImages: [String: NSImage] = [:]
    /// Tracks attachments for which every decode path (thumbnailImage, thumbnailData, full base64)
    /// was exhausted without producing an NSImage.  When an id is present here the view body
    /// renders the file-chip fallback so the user still sees the filename and a download
    /// affordance for corrupt or unsupported payloads.  The insert is intentionally placed
    /// AFTER all decode attempts and WITHOUT a Task.isCancelled guard so that a cancellation
    /// racing with the final decode failure always transitions the attachment out of the
    /// gray-placeholder state.
    @State private var failedIds: Set<String> = []

    @available(macOS, deprecated: 13.0)
    var body: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(imageAttachments, id: \.id) { attachment in
                Group {
                    if let nsImage = loadedImages[attachment.id] {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 60, height: 60)
                            .clipped()
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .onTapGesture {
                                onTap(attachment, nsImage)
                            }
                            .contextMenu {
                                ImageActions.contextMenuItems(
                                    image: nsImage,
                                    filename: attachment.filename,
                                    base64Data: attachment.data.isEmpty ? nil : attachment.data
                                )
                            }
                            .onDrag {
                                NotificationCenter.default.post(name: .internalImageDragStarted, object: nil)
                                let provider = NSItemProvider()
                                let hasBase64 = !attachment.data.isEmpty

                                // Pre-compute thumbnail PNG on main thread as a fallback.
                                // tiffRepresentation is not thread-safe so this must happen
                                // here, not in the lazy registerDataRepresentation callback.
                                let thumbnailPNG: Data? = {
                                    guard let img = loadedImages[attachment.id],
                                          let tiff = img.tiffRepresentation,
                                          let rep = NSBitmapImageRep(data: tiff) else { return nil }
                                    return rep.representation(using: .png, properties: [:])
                                }()

                                if hasBase64 {
                                    let mimeType = attachment.mimeType
                                    let utType = UTType(mimeType: mimeType) ?? .png
                                    let base64String = attachment.data
                                    provider.registerDataRepresentation(forTypeIdentifier: utType.identifier, visibility: .all) { completion in
                                        // Decode lazily when drop target requests data
                                        if let decoded = Data(base64Encoded: base64String), !decoded.isEmpty {
                                            completion(decoded, nil)
                                        } else if let thumbnailPNG {
                                            // Corrupt base64 — fall back to pre-computed thumbnail
                                            completion(thumbnailPNG, nil)
                                        } else {
                                            completion(nil, nil)
                                        }
                                        return nil
                                    }
                                } else if let thumbnailPNG {
                                    provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
                                        completion(thumbnailPNG, nil)
                                        return nil
                                    }
                                }
                                // Force .png extension when falling back to PNG encoding
                                let filename = attachment.filename
                                // Strip extension — Finder appends it from the UTType
                                provider.suggestedName = (filename as NSString).deletingPathExtension
                                return provider
                            }
                            .pointerCursor()
                    } else if failedIds.contains(attachment.id) {
                        // All decode paths failed — show a file chip so the user still has the
                        // filename and a download affordance for corrupt/unsupported payloads.
                        fallback(attachment)
                    } else {
                        // Placeholder shown while the image is being decoded off the main thread.
                        Rectangle()
                            .fill(VColor.surfaceActive)
                            .frame(width: 60, height: 60)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                }
                // NSImage(data:) is called directly inside .task — no Task{} wrapper — so
                // SwiftUI can cancel the work immediately when the bubble scrolls off-screen.
                // Wrapping in Task(priority:){}.value creates an unstructured task that is NOT
                // cancelled by the .task modifier, causing off-screen decodes to run to completion.
                .task(id: attachment.id) {
                    // Step 1: thumbnailImage is already decoded — zero cost.
                    if let img = attachment.thumbnailImage {
                        loadedImages[attachment.id] = img
                        return
                    }

                    guard !Task.isCancelled else { return }

                    // Step 2: thumbnailData (small) — synchronous NSImage decode, called directly.
                    // Fallback chain: thumbnailData → full attachment.data.
                    // thumbnailData is preferred (smaller), but if it is corrupt or
                    // missing we still want to show the image from the full payload.
                    if let thumbnailData = attachment.thumbnailData, !thumbnailData.isEmpty,
                       let img = NSImage(data: thumbnailData) {
                        guard !Task.isCancelled else { return }
                        loadedImages[attachment.id] = img
                        return
                    }

                    guard !Task.isCancelled else { return }

                    // Step 3: fallback to full base64 data.
                    if let fullData = Data(base64Encoded: attachment.data), !fullData.isEmpty,
                       let img = NSImage(data: fullData) {
                        guard !Task.isCancelled else { return }
                        loadedImages[attachment.id] = img
                        return
                    }

                    // All three decode paths exhausted with no image.
                    // Do NOT guard on Task.isCancelled here — once every decode path has
                    // failed we must always transition to the file-chip fallback regardless
                    // of cancellation. Without this, a cancellation that races with decode
                    // completion leaves the attachment permanently stuck on the gray
                    // placeholder instead of showing the filename/download affordance.
                    failedIds.insert(attachment.id)
                }
            }
        }
    }
}

// MARK: - Attachment Content

extension ChatBubble {
    var attachmentSummary: String {
        let count = message.attachments.count
        if count == 1 {
            return "Sent \(message.attachments[0].filename)"
        }
        return "Sent \(count) attachments"
    }

    /// Partitions attachments into image, video, and file buckets without
    /// performing any image decoding — decoding happens asynchronously in
    /// AttachmentImageGrid to keep NSImage(data:) off the layout path.
    var partitionedAttachments: (images: [ChatAttachment], videos: [ChatAttachment], files: [ChatAttachment]) {
        var images: [ChatAttachment] = []
        var videos: [ChatAttachment] = []
        var files: [ChatAttachment] = []
        for attachment in message.attachments {
            if attachment.mimeType.hasPrefix("image/") {
                images.append(attachment)
            } else if attachment.mimeType.hasPrefix("video/") {
                videos.append(attachment)
            } else {
                files.append(attachment)
            }
        }
        return (images, videos, files)
    }

    func attachmentImageGrid(_ images: [ChatAttachment]) -> some View {
        AttachmentImageGrid(imageAttachments: images, onTap: { attachment, image in
            ImageActions.openInPreview(
                image,
                filename: attachment.filename,
                base64Data: attachment.data.isEmpty ? nil : attachment.data
            )
        }) { attachment in
            fileAttachmentChip(attachment)
        }
    }

    func fileAttachmentChip(_ attachment: ChatAttachment) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(fileIcon(for: attachment.mimeType, fileName: attachment.filename), size: 14)
                .foregroundColor(isUser ? VColor.contentSecondary : VColor.contentSecondary)

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(isUser ? VColor.contentDefault : VColor.contentDefault)
                .lineLimit(1)

            if attachment.dataLength > 0 {
                Text(formattedFileSize(base64Length: attachment.dataLength))
                    .font(VFont.small)
                    .foregroundColor(isUser ? VColor.contentSecondary : VColor.contentTertiary)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isUser ? VColor.contentDefault.opacity(0.15) : VColor.borderBase.opacity(0.5))
        )
        .contentShape(Rectangle())
        .onTapGesture {
            saveFileAttachment(attachment)
        }
        .pointerCursor()
    }

    func saveFileAttachment(_ attachment: ChatAttachment) {
        guard !attachment.data.isEmpty,
              let data = Data(base64Encoded: attachment.data),
              !data.isEmpty else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (attachment.filename as NSString).lastPathComponent
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                try? data.write(to: url)
            }
        }
    }

    func fileIcon(for mimeType: String, fileName: String? = nil) -> VIcon {
        if mimeType.hasPrefix("video/") { return .video }
        if mimeType.hasPrefix("audio/") { return .audioWaveform }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/pdf" { return .file }
        if mimeType.contains("zip") || mimeType.contains("archive") { return .fileArchive }
        if mimeType.contains("json") || mimeType.contains("xml") { return .fileText }
        if let name = fileName, FileExtensions.isCode(name) { return .fileCode }
        return .file
    }

    func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.1f KB", kb) }
        let mb = kb / 1024
        return String(format: "%.1f MB", mb)
    }

    /// Number of tool calls in this message that have inline cached images.
    /// Used to suppress the corresponding tool-block image attachments from the
    /// attachment grid only when inline tool previews are actually rendered.
    var inlineToolCallImageCount: Int {
        message.toolCalls.filter { $0.cachedImage != nil }.count
    }

    /// Returns the image attachments that should still render in the attachment grid.
    /// When inline tool previews are visible, the matching tool-block images are
    /// hidden so we do not duplicate the same image twice. Non-tool images remain.
    ///
    /// After a history reload, `sourceType` is nil (not persisted in the DB), so
    /// we fall back to the old all-or-nothing approach: hide all image attachments
    /// when the count exactly matches the inline tool call count — this avoids
    /// duplicates while preserving non-tool images when counts differ.
    func visibleAttachmentImages(_ images: [ChatAttachment]) -> [ChatAttachment] {
        guard shouldRenderToolProgressInline, inlineToolCallImageCount > 0 else {
            return images
        }

        let anyHasSourceType = images.contains { $0.sourceType != nil }
        if !anyHasSourceType {
            // History reload: sourceType unavailable — fall back to hiding all
            // images when count matches to avoid duplicating inline tool previews.
            return images.count == inlineToolCallImageCount ? [] : images
        }

        var remainingInlineToolImages = inlineToolCallImageCount
        return images.filter { attachment in
            guard attachment.sourceType == "tool_block", remainingInlineToolImages > 0 else {
                return true
            }
            remainingInlineToolImages -= 1
            return false
        }
    }

    @ViewBuilder
    func attachmentWarningBanners(_ warnings: [String]) -> some View {
        if !warnings.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                    VInlineMessage(warning, tone: .warning)
                }
            }
        }
    }

    /// Renders cached images from completed tool calls inline below the
    /// progress view. This shows generated images (e.g. from image generation)
    /// at full width in the message flow instead of as tiny attachment thumbnails.
    @ViewBuilder
    func inlineToolCallImages(from toolCalls: [ToolCallData]) -> some View {
        let imagesWithIds: [(id: UUID, image: NSImage)] = toolCalls.compactMap { tc in
            guard let img = tc.cachedImage else { return nil }
            return (tc.id, img)
        }
        if !imagesWithIds.isEmpty {
            ForEach(imagesWithIds, id: \.id) { item in
                InlineToolCallImageView(image: item.image)
            }
        }
    }
}
