import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct TaskInputView: View {
    let onSubmit: (TaskSubmission) -> Void
    @State private var taskText = ""
    @State private var attachments: [TaskAttachment] = []
    @State private var attachmentError: String?
    @State private var isDropTargeted = false
    @FocusState private var isTextFieldFocused: Bool
    @Environment(\.openSettings) private var openSettings

    private var hasAPIKey: Bool {
        APIKeyManager.getKey() != nil
    }

    private var canSubmit: Bool {
        let trimmed = taskText.trimmingCharacters(in: .whitespacesAndNewlines)
        return hasAPIKey && (!trimmed.isEmpty || !attachments.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("vellum-assistant")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Spacer()
                Button(action: {
                    // LSUIElement apps need to become regular apps temporarily to take focus
                    NSApp.setActivationPolicy(.regular)
                    openSettings()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        NSApp.activate(ignoringOtherApps: true)
                    }
                }) {
                    Image(systemName: "gear")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }

            TextEditor(text: $taskText)
                .font(.body)
                .frame(minHeight: 60, maxHeight: 100)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(Color(.textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .focused($isTextFieldFocused)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(isDropTargeted ? Color.accentColor : Color.clear, lineWidth: 2)
                )
                .onDrop(
                    of: [UTType.fileURL.identifier, UTType.image.identifier],
                    isTargeted: $isDropTargeted,
                    perform: handleItemProviders
                )
                .onPasteCommand(of: [.fileURL, .image], perform: handlePasteCommand)

            if !attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(attachments) { attachment in
                            HStack(spacing: 6) {
                                Image(systemName: attachment.kind == .image ? "photo" : "doc")
                                    .font(.caption)
                                Text(attachment.fileName)
                                    .font(.caption)
                                    .lineLimit(1)
                                Text("(\(ByteCountFormatter.string(fromByteCount: Int64(attachment.sizeBytes), countStyle: .file)))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Button {
                                    removeAttachment(id: attachment.id)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.caption)
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 5)
                            .background(Color(.windowBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
                            )
                        }
                    }
                    .padding(.vertical, 2)
                }
            }

            if let attachmentError {
                Text(attachmentError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if !hasAPIKey {
                Text("No API key configured. Open Settings to add one.")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                Button {
                    openFilePicker()
                } label: {
                    Image(systemName: "paperclip")
                }
                .help("Attach files")
                .disabled(!hasAPIKey)

                Spacer()
                Button("Go") {
                    submitTask()
                }
                .keyboardShortcut(.return, modifiers: [])
                .disabled(!canSubmit)
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 320)
        .onAppear {
            isTextFieldFocused = true
        }
    }

    private func submitTask() {
        let trimmed = taskText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let submission = TaskSubmission(task: trimmed, attachments: attachments)
        taskText = ""
        attachments = []
        attachmentError = nil
        onSubmit(submission)
    }

    private func removeAttachment(id: UUID) {
        attachments.removeAll { $0.id == id }
    }

    private func pickerTypes() -> [UTType] {
        var types: [UTType] = [
            .png,
            .jpeg,
            .gif,
            .pdf,
            .plainText,
            .utf8PlainText,
            .json
        ]
        if let webp = UTType(filenameExtension: "webp") { types.append(webp) }
        if let markdown = UTType(filenameExtension: "md") { types.append(markdown) }
        if let csv = UTType(filenameExtension: "csv") { types.append(csv) }
        if let docx = UTType(filenameExtension: "docx") { types.append(docx) }
        if let xlsx = UTType(filenameExtension: "xlsx") { types.append(xlsx) }
        if let pptx = UTType(filenameExtension: "pptx") { types.append(pptx) }
        return types
    }

    private func openFilePicker() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = pickerTypes()

        guard panel.runModal() == .OK else { return }
        addFileURLs(panel.urls)
    }

    private func handlePasteCommand(_ providers: [NSItemProvider]) {
        if handleItemProviders(providers) {
            return
        }

        let pasteboard = NSPasteboard.general
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], !urls.isEmpty {
            addFileURLs(urls)
            return
        }
        if let image = NSImage(pasteboard: pasteboard), let data = image.pngData() {
            addPastedImage(data)
            return
        }

        reportAttachmentError("Clipboard does not contain a supported file or image.")
    }

    private func handleItemProviders(_ providers: [NSItemProvider]) -> Bool {
        var handled = false

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                handled = true
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
                    if let error {
                        reportAttachmentError(error.localizedDescription)
                        return
                    }
                    guard let url = Self.fileURL(from: item) else {
                        reportAttachmentError("Unable to read file URL from drop/paste item.")
                        return
                    }
                    addFileURLs([url])
                }
                continue
            }

            if provider.canLoadObject(ofClass: NSImage.self) {
                handled = true
                provider.loadObject(ofClass: NSImage.self) { image, error in
                    if let error {
                        reportAttachmentError(error.localizedDescription)
                        return
                    }
                    guard let image = image as? NSImage, let data = image.pngData() else {
                        reportAttachmentError("Unable to read image data from drop/paste item.")
                        return
                    }
                    addPastedImage(data)
                }
            }
        }

        return handled
    }

    private func addFileURLs(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        DispatchQueue.main.async {
            var newAttachments: [TaskAttachment] = []
            var errors: [String] = []
            for url in urls {
                do {
                    newAttachments.append(try TaskAttachment.fromFileURL(url))
                } catch {
                    errors.append(error.localizedDescription)
                }
            }
            if !newAttachments.isEmpty {
                attachments.append(contentsOf: newAttachments)
                attachmentError = nil
            }
            if !errors.isEmpty {
                attachmentError = errors.joined(separator: " ")
            }
        }
    }

    private func addPastedImage(_ data: Data) {
        DispatchQueue.main.async {
            do {
                let attachment = try TaskAttachment.fromPastedImage(data)
                attachments.append(attachment)
                attachmentError = nil
            } catch {
                attachmentError = error.localizedDescription
            }
        }
    }

    private func reportAttachmentError(_ message: String) {
        DispatchQueue.main.async {
            attachmentError = message
        }
    }

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

private extension NSImage {
    func pngData() -> Data? {
        guard let tiff = tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff) else {
            return nil
        }
        return bitmap.representation(using: .png, properties: [:])
    }
}
