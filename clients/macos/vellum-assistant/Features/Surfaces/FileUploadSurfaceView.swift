import SwiftUI
import AppKit
import UniformTypeIdentifiers
import PDFKit

struct FileUploadSurfaceView: View {
    let data: FileUploadSurfaceData
    let onAction: (String, [String: Any]?) -> Void

    @State private var selectedFiles: [SelectedFile] = []
    @State private var isDropTargeted = false
    @State private var errorMessage: String?
    @State private var isProcessing = false

    private var effectiveMaxFiles: Int { data.maxFiles ?? 1 }
    private var effectiveMaxSizeBytes: Int { data.maxSizeBytes ?? (50 * 1024 * 1024) }

    private var canSubmit: Bool {
        !selectedFiles.isEmpty && !isProcessing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Prompt
            Text(data.prompt)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)

            // Drop zone
            dropZone

            // Selected files list
            if !selectedFiles.isEmpty {
                filesList
            }

            // Error message
            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            // Action buttons
            HStack(spacing: VSpacing.lg) {
                Spacer()

                VButton(label: "Cancel", style: .ghost) {
                    onAction("cancel", [:])
                }

                VButton(
                    label: isProcessing ? "Processing..." : "Submit",
                    style: .primary,
                    isDisabled: !canSubmit
                ) {
                    submitFiles()
                }
            }
        }
    }

    // MARK: - Drop Zone

    private var dropZone: some View {
        VStack(spacing: VSpacing.md) {
            Image(systemName: "arrow.down.doc")
                .font(.system(size: 28))
                .foregroundColor(isDropTargeted ? VColor.accent : VColor.textMuted)

            Text("Drop files here")
                .font(VFont.bodyMedium)
                .foregroundColor(isDropTargeted ? VColor.textPrimary : VColor.textSecondary)

            if let types = data.acceptedTypes, !types.isEmpty {
                Text(types.joined(separator: ", "))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }

            Button(action: openFilePicker) {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "folder")
                        .font(VFont.caption)
                    Text("Browse Files")
                        .font(VFont.captionMedium)
                }
                .foregroundColor(VColor.accent)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.accent.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(VSpacing.xl)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(
                    isDropTargeted ? VColor.accent : VColor.surfaceBorder,
                    style: StrokeStyle(lineWidth: 2, dash: [8, 4])
                )
        )
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(isDropTargeted ? VColor.accent.opacity(0.05) : Color.clear)
        )
        .onDrop(of: [.fileURL], isTargeted: $isDropTargeted, perform: handleDrop)
    }

    // MARK: - Files List

    private var filesList: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(selectedFiles) { file in
                HStack(spacing: VSpacing.md) {
                    // Thumbnail or icon
                    fileIcon(for: file)
                        .frame(width: 32, height: 32)

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(file.filename)
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)

                        Text(ByteCountFormatter.string(
                            fromByteCount: Int64(file.sizeBytes),
                            countStyle: .file
                        ))
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    }

                    Spacer()

                    Button(action: { removeFile(id: file.id) }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundColor(VColor.textMuted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(VSpacing.sm)
                .background(VColor.backgroundSubtle)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            }
        }
    }

    // MARK: - File Icon

    @ViewBuilder
    private func fileIcon(for file: SelectedFile) -> some View {
        if file.mimeType.hasPrefix("image/"), let image = NSImage(data: file.data) {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
        } else {
            Image(systemName: iconName(for: file.mimeType))
                .font(.system(size: 18))
                .foregroundColor(VColor.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.accent.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
        }
    }

    private func iconName(for mimeType: String) -> String {
        if mimeType == "application/pdf" { return "doc.richtext" }
        if mimeType.hasPrefix("text/") { return "doc.text" }
        if mimeType == "application/json" { return "curlybraces" }
        return "doc"
    }

    // MARK: - File Picker

    private func openFilePicker() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = effectiveMaxFiles > 1
        panel.allowedContentTypes = allowedUTTypes()

        guard panel.runModal() == .OK else { return }
        addFileURLs(panel.urls)
    }

    // MARK: - Drag & Drop

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        var handled = false

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                handled = true
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                    if error != nil { return }
                    guard let url = Self.fileURL(from: item) else { return }
                    DispatchQueue.main.async {
                        addFileURLs([url])
                    }
                }
            }
        }

        return handled
    }

    // MARK: - File Processing

    private func addFileURLs(_ urls: [URL]) {
        errorMessage = nil
        var errors: [String] = []

        for url in urls {
            if selectedFiles.count >= effectiveMaxFiles {
                errors.append("Maximum \(effectiveMaxFiles) file(s) allowed.")
                break
            }

            do {
                let fileData = try Data(contentsOf: url)
                let filename = url.lastPathComponent
                let mimeType = Self.mimeType(for: url.pathExtension)

                // Validate accepted types
                if let acceptedTypes = self.data.acceptedTypes, !acceptedTypes.isEmpty {
                    let matches = acceptedTypes.contains { pattern in
                        if pattern.hasSuffix("/*") {
                            let prefix = String(pattern.dropLast(2))
                            return mimeType.hasPrefix(prefix)
                        }
                        return mimeType == pattern
                    }
                    if !matches {
                        errors.append("\(filename) is not an accepted file type.")
                        continue
                    }
                }

                // Validate size
                if fileData.count > effectiveMaxSizeBytes {
                    let maxSize = ByteCountFormatter.string(
                        fromByteCount: Int64(effectiveMaxSizeBytes),
                        countStyle: .file
                    )
                    errors.append("\(filename) exceeds the \(maxSize) size limit.")
                    continue
                }

                let extractedText = Self.extractText(data: fileData, mimeType: mimeType)

                let file = SelectedFile(
                    id: UUID(),
                    filename: filename,
                    mimeType: mimeType,
                    sizeBytes: fileData.count,
                    data: fileData,
                    extractedText: extractedText
                )
                selectedFiles.append(file)
            } catch {
                errors.append("Failed to read \(url.lastPathComponent).")
            }
        }

        if !errors.isEmpty {
            errorMessage = errors.joined(separator: " ")
        }
    }

    private func removeFile(id: UUID) {
        selectedFiles.removeAll { $0.id == id }
        errorMessage = nil
    }

    // MARK: - Submit

    private func submitFiles() {
        guard !selectedFiles.isEmpty else { return }
        isProcessing = true

        let filesPayload: [[String: Any]] = selectedFiles.map { file in
            var entry: [String: Any] = [
                "filename": file.filename,
                "mimeType": file.mimeType,
                "data": file.data.base64EncodedString(),
            ]
            if let text = file.extractedText {
                entry["extractedText"] = text
            }
            return entry
        }

        let actionData: [String: Any] = ["files": filesPayload]
        onAction("submit", actionData)
    }

    // MARK: - UTType Helpers

    private func allowedUTTypes() -> [UTType] {
        guard let acceptedTypes = data.acceptedTypes, !acceptedTypes.isEmpty else {
            // Default: all common file types
            return [.image, .pdf, .plainText, .json]
        }

        var types: [UTType] = []
        for pattern in acceptedTypes {
            if let utType = Self.utType(from: pattern) {
                types.append(utType)
            }
        }
        return types.isEmpty ? [.data] : types
    }

    private static func utType(from mimePattern: String) -> UTType? {
        // Handle wildcard patterns like "image/*"
        switch mimePattern {
        case "image/*": return .image
        case "video/*": return .video
        case "audio/*": return .audio
        case "text/*": return .text
        default: break
        }

        // Handle specific MIME types
        if let utType = UTType(mimeType: mimePattern) {
            return utType
        }
        return nil
    }

    // MARK: - MIME Detection

    private static func mimeType(for pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        case "md", "markdown": return "text/markdown"
        case "json": return "application/json"
        case "csv": return "text/csv"
        default: return "application/octet-stream"
        }
    }

    // MARK: - Text Extraction

    private static func extractText(data: Data, mimeType: String) -> String? {
        if mimeType == "application/pdf" {
            return extractPdfText(data: data)
        }
        if mimeType.hasPrefix("text/") || mimeType == "application/json" {
            let text = String(data: data, encoding: .utf8)
            return text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == true ? nil : text
        }
        return nil
    }

    private static func extractPdfText(data: Data) -> String? {
        guard let document = PDFDocument(data: data) else { return nil }
        var parts: [String] = []
        for pageIndex in 0..<document.pageCount {
            guard let page = document.page(at: pageIndex), let text = page.string else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                parts.append(trimmed)
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    // MARK: - URL Helpers

    private static func fileURL(from item: NSSecureCoding?) -> URL? {
        if let data = item as? Data {
            return URL(dataRepresentation: data, relativeTo: nil)
        }
        if let url = item as? URL {
            return url
        }
        if let str = item as? String, let url = URL(string: str), url.isFileURL {
            return url
        }
        return nil
    }
}

// MARK: - Selected File Model

struct SelectedFile: Identifiable {
    let id: UUID
    let filename: String
    let mimeType: String
    let sizeBytes: Int
    let data: Data
    let extractedText: String?
}

// MARK: - Preview

#Preview {
    FileUploadSurfaceView(
        data: FileUploadSurfaceData(
            prompt: "Please share the design file you'd like me to review.",
            acceptedTypes: ["image/*", "application/pdf"],
            maxFiles: 3,
            maxSizeBytes: 10 * 1024 * 1024
        ),
        onAction: { actionId, data in
            print("Action: \(actionId), data: \(String(describing: data))")
        }
    )
    .padding()
    .frame(width: 480)
    .vPanelBackground()
}
