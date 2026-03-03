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
private struct AttachmentImageGrid: View {
    let imageAttachments: [ChatAttachment]
    let onTap: (ChatAttachment) -> Void

    @State private var loadedImages: [String: NSImage] = [:]

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(imageAttachments, id: \.id) { attachment in
                Group {
                    if let nsImage = loadedImages[attachment.id] {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        // Placeholder shown while the image is being decoded off the main thread.
                        Rectangle()
                            .fill(Color.gray.opacity(0.2))
                    }
                }
                .frame(width: 60, height: 60)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .onTapGesture {
                    onTap(attachment)
                }
                // Decode off the main actor so NSImage(data:) never runs during layout.
                .task(id: attachment.id) {
                    if let img = attachment.thumbnailImage {
                        loadedImages[attachment.id] = img
                        return
                    }
                    let imageData = attachment.thumbnailData ?? Data(base64Encoded: attachment.data)
                    guard let imageData, !imageData.isEmpty else { return }
                    let decoded = await Task.detached(priority: .userInitiated) {
                        NSImage(data: imageData)
                    }.value
                    guard !Task.isCancelled, let decoded else { return }
                    loadedImages[attachment.id] = decoded
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
        AttachmentImageGrid(imageAttachments: images, onTap: openImageInPreview)
    }

    func fileAttachmentChip(_ attachment: ChatAttachment) -> some View {
        HStack(spacing: VSpacing.xs) {
            Image(systemName: fileIcon(for: attachment.mimeType))
                .font(VFont.caption)
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
        .onHover { hovering in
            if hovering {
                NSCursor.pointingHand.push()
            } else {
                NSCursor.pop()
            }
        }
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

    func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("video/") { return "film" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
        if mimeType.hasPrefix("text/") { return "doc.text.fill" }
        if mimeType == "application/pdf" { return "doc.fill" }
        if mimeType.contains("zip") || mimeType.contains("archive") { return "doc.zipper" }
        if mimeType.contains("json") || mimeType.contains("xml") { return "doc.text.fill" }
        return "doc.fill"
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
