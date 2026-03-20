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
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
        .padding(.vertical, VSpacing.xs)
        .padding(.horizontal, VSpacing.sm)
        .background(VColor.borderBase.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    func attachmentChip(_ attachment: ChatAttachment) -> some View {
        let fileSize = formattedFileSize(base64Length: attachment.dataLength)
        let isImage = attachment.mimeType.hasPrefix("image/")

        return HStack(spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                if isImage, let nsImage = attachment.thumbnailImage {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 28, height: 28)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                } else {
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.borderBase.opacity(0.5))
                        .frame(width: 28, height: 28)
                        .overlay {
                            VIconView(iconForMimeType(attachment.mimeType, filename: attachment.filename), size: 14)
                                .foregroundColor(VColor.contentSecondary)
                        }
                }

                Text(attachment.filename)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Text("· \(fileSize)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            .contentShape(Rectangle())
            .if(isImage) { view in
                view
                    .onTapGesture { openAttachmentPreview(attachment) }
                    .pointerCursor()
            }

            Button {
                onRemoveAttachment(attachment.id)
            } label: {
                VIconView(.x, size: 10)
                    .foregroundColor(VColor.contentTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
        .padding(.vertical, VSpacing.xs)
        .padding(.horizontal, VSpacing.sm)
        .background(VColor.borderBase.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .frame(maxWidth: 280)
    }
}

// MARK: - Attachment Preview

extension ComposerView {
    func openAttachmentPreview(_ attachment: ChatAttachment) {
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
}

// MARK: - Attachment Helpers

extension ComposerView {
    func formattedFileSize(base64Length: Int) -> String {
        let bytes = base64Length * 3 / 4
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
