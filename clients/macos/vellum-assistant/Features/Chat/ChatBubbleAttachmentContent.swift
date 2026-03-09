import SwiftUI
import VellumAssistantShared

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
    let onTap: (ChatAttachment) -> Void
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
                                onTap(attachment)
                            }
                    } else if failedIds.contains(attachment.id) {
                        // All decode paths failed — show a file chip so the user still has the
                        // filename and a download affordance for corrupt/unsupported payloads.
                        fallback(attachment)
                    } else {
                        // Placeholder shown while the image is being decoded off the main thread.
                        Rectangle()
                            .fill(Color.gray.opacity(0.2))
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
        AttachmentImageGrid(imageAttachments: images, onTap: openImageInPreview) { attachment in
            fileAttachmentChip(attachment)
        }
    }

    func fileAttachmentChip(_ attachment: ChatAttachment) -> some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(fileIcon(for: attachment.mimeType), size: 14)
                .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textSecondary)

            Text(attachment.filename)
                .font(VFont.caption)
                .foregroundColor(isUser ? VColor.userBubbleText : VColor.textPrimary)
                .lineLimit(1)

            if attachment.dataLength > 0 {
                Text(formattedFileSize(base64Length: attachment.dataLength))
                    .font(VFont.small)
                    .foregroundColor(isUser ? VColor.userBubbleTextSecondary : VColor.textMuted)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isUser ? VColor.userBubbleText.opacity(0.15) : VColor.surfaceBorder.opacity(0.5))
        )
        .contentShape(Rectangle())
        .onTapGesture {
            saveFileAttachment(attachment)
        }
        .pointerCursor()
    }

    func openImageInPreview(_ attachment: ChatAttachment) {
        guard !attachment.data.isEmpty,
              let data = Data(base64Encoded: attachment.data),
              !data.isEmpty else { return }
        let tempDir = FileManager.default.temporaryDirectory
        let sanitized = (attachment.filename as NSString).lastPathComponent
        let fileURL = tempDir.appendingPathComponent(sanitized.isEmpty ? "image" : sanitized)
        do {
            try data.write(to: fileURL)
            NSWorkspace.shared.open(fileURL)
        } catch {
            // Silently fail — not critical
        }
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

    func fileIcon(for mimeType: String) -> VIcon {
        if mimeType.hasPrefix("video/") { return .film }
        if mimeType.hasPrefix("audio/") { return .audioWaveform }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType == "application/pdf" { return .file }
        if mimeType.contains("zip") || mimeType.contains("archive") { return .fileArchive }
        if mimeType.contains("json") || mimeType.contains("xml") { return .fileText }
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
}
