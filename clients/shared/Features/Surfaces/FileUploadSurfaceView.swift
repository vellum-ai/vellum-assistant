#if os(macOS)
import SwiftUI
import UniformTypeIdentifiers

public struct FileUploadSurfaceView: View {
    let data: FileUploadSurfaceData
    let onSubmit: ([[String: Any]]) -> Void
    let onCancel: () -> Void

    @State private var selectedFiles: [SelectedFile] = []
    @State private var isDragOver = false
    @State private var errorMessage: String?
    @State private var isSubmitted = false
    @State private var isSuccessExpanded = false

    public init(data: FileUploadSurfaceData, onSubmit: @escaping ([[String: Any]]) -> Void, onCancel: @escaping () -> Void) {
        self.data = data
        self.onSubmit = onSubmit
        self.onCancel = onCancel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if isSubmitted {
                // Success state — expandable
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Button(action: { withAnimation(VAnimation.fast) { isSuccessExpanded.toggle() } }) {
                        HStack(spacing: VSpacing.sm) {
                            VIconView(.circleCheck, size: 16)
                                .foregroundStyle(VColor.systemPositiveStrong)
                            Text("Uploaded \(selectedFiles.count) file\(selectedFiles.count == 1 ? "" : "s")")
                                .font(VFont.bodyMediumLighter)
                                .foregroundStyle(VColor.contentSecondary)
                            Spacer()
                            VIconView(.chevronRight, size: 10)
                                .foregroundStyle(VColor.contentTertiary)
                                .rotationEffect(.degrees(isSuccessExpanded ? 90 : 0))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if isSuccessExpanded {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            ForEach(selectedFiles) { file in
                                HStack(spacing: VSpacing.sm) {
                                    fileIcon(for: file)
                                        .frame(width: 28, height: 28)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(file.filename)
                                            .font(VFont.labelDefault)
                                            .foregroundStyle(VColor.contentDefault)
                                            .lineLimit(1)
                                        Text(formatFileSize(file.size))
                                            .font(VFont.labelSmall)
                                            .foregroundStyle(VColor.contentTertiary)
                                    }
                                    Spacer()
                                }
                                .padding(VSpacing.xs)
                            }
                        }
                        .padding(.leading, VSpacing.lg + VSpacing.sm)
                    }
                }
            } else {
                // Prompt text
                Text(data.prompt)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .textSelection(.enabled)

                // Drop zone
                dropZone

                // Error message
                if let errorMessage = errorMessage {
                    Text(errorMessage)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.systemNegativeStrong)
                        .textSelection(.enabled)
                }

                // File previews
                if !selectedFiles.isEmpty {
                    fileList
                }

                // Constraints hint
                constraintsHint

                // Action buttons
                HStack(spacing: VSpacing.lg) {
                    Spacer()

                    Button(action: { onCancel() }) {
                        Text("Cancel")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.sm)
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .stroke(VColor.borderBase, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)

                    Button(action: { submitFiles() }) {
                        Text("Upload")
                            .font(VFont.labelDefault)
                            .foregroundStyle(selectedFiles.isEmpty ? VColor.contentTertiary : VColor.auxWhite)
                            .padding(.horizontal, VSpacing.lg)
                            .padding(.vertical, VSpacing.sm)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .fill(selectedFiles.isEmpty ? VColor.surfaceOverlay : VColor.primaryBase)
                            )
                    }
                    .buttonStyle(.plain)
                    .disabled(selectedFiles.isEmpty)
                }
            }
        }
    }

    // MARK: - Drop Zone

    private var dropZone: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    isDragOver ? VColor.primaryBase : VColor.contentTertiary,
                    style: StrokeStyle(lineWidth: 2, dash: [8, 4])
                )
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(isDragOver ? VColor.primaryBase.opacity(0.08) : Color.clear)
                )

            VStack(spacing: VSpacing.md) {
                VIconView(.arrowDownToLine, size: 28)
                    .foregroundStyle(isDragOver ? VColor.primaryBase : VColor.contentTertiary)

                Text("Drop files here")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)

                Button(action: { browseFiles() }) {
                    Text("Browse files")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.primaryBase)
                }
                .buttonStyle(.plain)
            }
            .padding(VSpacing.xl)
        }
        .frame(height: 140)
        .onDrop(of: [.fileURL], isTargeted: $isDragOver) { providers in
            handleDrop(providers)
            return true
        }
    }

    // MARK: - File List

    private var fileList: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            ForEach(Array(selectedFiles.enumerated()), id: \.element.id) { index, file in
                HStack(spacing: VSpacing.md) {
                    fileIcon(for: file)
                        .frame(width: 32, height: 32)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.filename)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentDefault)
                            .lineLimit(1)
                            .textSelection(.enabled)

                        Text(formatFileSize(file.size))
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .textSelection(.enabled)
                    }

                    Spacer()

                    Button(action: { removeFile(at: index) }) {
                        VIconView(.circleX, size: 14)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(VColor.surfaceOverlay)
                )
            }
        }
    }

    // MARK: - Constraints Hint

    private var constraintsHint: some View {
        HStack(spacing: VSpacing.sm) {
            if data.maxFiles > 1 {
                Text("Max \(data.maxFiles) files")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .textSelection(.enabled)
            }
            if let types = data.acceptedTypes, !types.isEmpty {
                Text(types.joined(separator: ", "))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: - File Icon

    @ViewBuilder
    private func fileIcon(for file: SelectedFile) -> some View {
        if file.mimeType.hasPrefix("image/"), let nsImage = NSImage(data: file.data) {
            Image(nsImage: nsImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 32, height: 32)
                .cornerRadius(4)
                .clipped()
        } else {
            VIconView(iconName(for: file.mimeType), size: 20)
                .foregroundStyle(VColor.primaryBase)
                .frame(width: 32, height: 32)
        }
    }

    private func iconName(for mimeType: String) -> VIcon {
        if mimeType.hasPrefix("image/") { return .image }
        if mimeType == "application/pdf" { return .fileText }
        if mimeType.contains("spreadsheet") || mimeType.contains("csv") { return .table }
        if mimeType.contains("presentation") { return .layers }
        return .file
    }

    // MARK: - Actions

    private func browseFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = data.maxFiles > 1
        panel.canChooseDirectories = false
        panel.canChooseFiles = true

        if let types = data.acceptedTypes {
            let utTypes = types.compactMap { utType(from: $0) }
            if !utTypes.isEmpty {
                panel.allowedContentTypes = utTypes
            }
        }

        panel.begin { response in
            guard response == .OK else { return }
            for url in panel.urls {
                addFile(from: url)
            }
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) {
        for provider in providers {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil) else { return }
                DispatchQueue.main.async {
                    addFile(from: url)
                }
            }
        }
    }

    private func addFile(from url: URL) {
        errorMessage = nil

        // Check max files limit
        if selectedFiles.count >= data.maxFiles {
            errorMessage = "Maximum of \(data.maxFiles) file\(data.maxFiles == 1 ? "" : "s") allowed."
            return
        }

        // Check file size before reading into memory to avoid OOM on large files
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let fileSize = attrs[.size] as? Int else {
            errorMessage = "Could not read file: \(url.lastPathComponent)"
            return
        }
        if fileSize > data.maxSizeBytes {
            errorMessage = "\(url.lastPathComponent) exceeds the \(formatFileSize(data.maxSizeBytes)) size limit."
            return
        }

        // Now safe to read the file data
        guard let fileData = try? Data(contentsOf: url) else {
            errorMessage = "Could not read file: \(url.lastPathComponent)"
            return
        }

        // Re-check size after read in case file changed between stat and read
        if fileData.count > data.maxSizeBytes {
            errorMessage = "\(url.lastPathComponent) exceeds the \(formatFileSize(data.maxSizeBytes)) size limit."
            return
        }

        // Check accepted types
        let mimeType = mimeType(for: url)
        if let acceptedTypes = data.acceptedTypes, !acceptedTypes.isEmpty {
            let matches = acceptedTypes.contains { pattern in
                if pattern.hasSuffix("/*") {
                    let prefix = String(pattern.dropLast(2))
                    return mimeType.hasPrefix(prefix)
                }
                return mimeType == pattern
            }
            if !matches {
                errorMessage = "\(url.lastPathComponent) is not an accepted file type."
                return
            }
        }

        // Check for duplicates
        let filename = url.lastPathComponent
        if selectedFiles.contains(where: { $0.filename == filename }) {
            return
        }

        selectedFiles.append(SelectedFile(
            filename: filename,
            mimeType: mimeType,
            data: fileData,
            size: fileData.count
        ))
    }

    private func removeFile(at index: Int) {
        guard index < selectedFiles.count else { return }
        selectedFiles.remove(at: index)
        errorMessage = nil
    }

    private func submitFiles() {
        guard !selectedFiles.isEmpty else { return }

        let filesPayload: [[String: Any]] = selectedFiles.map { file in
            var dict: [String: Any] = [
                "filename": file.filename,
                "mimeType": file.mimeType,
                "data": file.data.base64EncodedString(),
            ]
            // Extract text from known text-based formats
            if let text = extractText(from: file) {
                dict["extractedText"] = text
            }
            return dict
        }

        isSubmitted = true
        onSubmit(filesPayload)

        // Release heavy file data from memory — the success state only needs
        // filename and size for display.
        selectedFiles = selectedFiles.map {
            SelectedFile(filename: $0.filename, mimeType: $0.mimeType, data: Data(), size: $0.size)
        }
    }

    // MARK: - Helpers

    private func mimeType(for url: URL) -> String {
        if let utType = UTType(filenameExtension: url.pathExtension) {
            return utType.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
    }

    private func utType(from mimePattern: String) -> UTType? {
        if mimePattern.hasSuffix("/*") {
            // Wildcard type — map common categories
            let prefix = String(mimePattern.dropLast(2))
            switch prefix {
            case "image": return .image
            case "video": return .video
            case "audio": return .audio
            case "text": return .text
            default: return nil
            }
        }
        return UTType(mimeType: mimePattern)
    }

    private func extractText(from file: SelectedFile) -> String? {
        let textTypes = ["text/plain", "text/csv", "text/html", "text/markdown",
                         "application/json", "application/xml"]
        if textTypes.contains(file.mimeType) || file.mimeType.hasPrefix("text/") {
            return String(data: file.data, encoding: .utf8)
        }
        return nil
    }
}

// MARK: - Supporting Types

private struct SelectedFile: Identifiable {
    let id = UUID()
    let filename: String
    let mimeType: String
    let data: Data
    let size: Int
}
#endif
