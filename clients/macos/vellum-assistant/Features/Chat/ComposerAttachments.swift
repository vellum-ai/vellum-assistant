import SwiftUI
import VellumAssistantShared
#if os(macOS)
import AppKit
#endif

// MARK: - Attachment Preview Strip

extension ComposerView {
    var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: VSpacing.sm) {
                ForEach(pendingAttachments) { attachment in
                    attachmentChip(attachment)
                }
                if isLoadingAttachment {
                    attachmentLoadingChip
                }
            }
            .padding(.top, VSpacing.sm)
            .padding(.bottom, VSpacing.xs)
        }
    }

    private var attachmentLoadingChip: some View {
        HStack(spacing: VSpacing.sm) {
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.borderBase.opacity(0.5))
                .frame(width: 28, height: 28)
                .overlay {
                    ProgressView()
                        .scaleEffect(0.5)
                }

            Text("Processing…")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(VSpacing.xs)
        .background(VColor.borderBase.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    func attachmentChip(_ attachment: ChatAttachment) -> some View {
        let fileSize: String
        if let sizeBytes = attachment.sizeBytes, attachment.dataLength == 0 {
            fileSize = formattedFileSizeBytes(sizeBytes)
        } else {
            fileSize = formattedFileSize(base64Length: attachment.dataLength)
        }
        let isImage = attachment.mimeType.hasPrefix("image/")

        return HStack(spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.xs) {
                if isImage, let nsImage = attachment.thumbnailImage {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 28, height: 28)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                } else {
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.surfaceActive)
                        .frame(width: 28, height: 28)
                        .overlay {
                            VIconView(iconForMimeType(attachment.mimeType, filename: attachment.filename), size: 14)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                }

                Text(attachment.filename)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text("·")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)

                Text(fileSize)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .contentShape(Rectangle())
            .if(isImage) { view in
                view
                    .onTapGesture { openAttachmentPreview(attachment) }
                    .pointerCursor()
            }

            AttachmentRemoveButton {
                onRemoveAttachment(attachment.id)
            }
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceActive)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(RoundedRectangle(cornerRadius: VRadius.md).strokeBorder(VColor.borderHover, lineWidth: 1))
        .frame(maxWidth: 280)
    }
}

// MARK: - Attachment Remove Button

private struct AttachmentRemoveButton: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VIconView(.x, size: 10)
                .foregroundStyle(isHovered ? VColor.contentDefault : VColor.contentTertiary)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .pointerCursor()
    }
}

// MARK: - Attachment Preview

extension ComposerView {
    func openAttachmentPreview(_ attachment: ChatAttachment) {
        // Prefer full-resolution data for the lightbox, fall back to thumbnail
        let image: NSImage?
        if !attachment.data.isEmpty,
           let data = Data(base64Encoded: attachment.data),
           !data.isEmpty,
           let fullRes = NSImage(data: data) {
            image = fullRes
        } else if let thumbnail = attachment.thumbnailImage {
            image = thumbnail
        } else {
            image = nil
        }
        guard let image else { return }
        AppDelegate.shared?.mainWindow?.windowState.showImageLightbox(
            image: image,
            filename: attachment.filename,
            base64Data: attachment.data.isEmpty ? nil : attachment.data
        )
    }
}

// MARK: - Attachment Helpers

extension ComposerView {
    func formattedFileSize(base64Length: Int) -> String {
        formattedFileSizeBytes(base64Length * 3 / 4)
    }

    func formattedFileSizeBytes(_ bytes: Int) -> String {
        if bytes < 1024 {
            return "\(bytes) B"
        } else if bytes < 1024 * 1024 {
            return "\(bytes / 1024) KB"
        } else {
            let mb = Double(bytes) / (1024 * 1024)
            return String(format: "%.1f MB", mb)
        }
    }

    func iconForMimeType(_ mimeType: String, filename: String) -> VIcon {
        if mimeType == "application/pdf" { return .file }
        if mimeType.hasPrefix("text/") { return .fileText }
        if mimeType.hasPrefix("image/") { return .image }
        let ext = filename.split(separator: ".").last.map(String.init) ?? ""
        switch ext.lowercased() {
        case "pdf": return .file
        case "csv": return .table
        case "md", "txt": return .fileText
        default: return .file
        }
    }
}
