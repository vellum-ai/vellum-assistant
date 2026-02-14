import SwiftUI
import VellumAssistantShared
import AppKit
import UniformTypeIdentifiers

struct TaskInputView: View {
    private static let maxAttachmentCount = 10
    private static let maxTotalAttachmentBytes = 50 * 1024 * 1024
    let onSubmit: (TaskSubmission) -> Void
    @ObservedObject var daemonClient: DaemonClient
    @State private var taskText = ""
    @State private var hasAPIKey = APIKeyManager.getKey() != nil
    @State private var attachments: [TaskAttachment] = []
    @State private var attachmentError: String?
    @State private var isDropTargeted = false
    @FocusState private var isTextFieldFocused: Bool
    // Use NSApp action instead of @Environment(\.openSettings) for Xcode 16.2 compatibility
    private func openSettings() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    private var canSubmit: Bool {
        let trimmed = taskText.trimmingCharacters(in: .whitespacesAndNewlines)
        return hasAPIKey && (!trimmed.isEmpty || !attachments.isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack {
                Text(UserDefaults.standard.string(forKey: "assistantName") ?? "Vellum")
                    .font(VFont.headline)
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
                .font(VFont.body)
                .frame(minHeight: 60, maxHeight: 100)
                .scrollContentBackground(.hidden)
                .padding(VSpacing.md)
                .background(Color(.textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .focused($isTextFieldFocused)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
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
                            .padding(.horizontal, VSpacing.md)
                            .padding(.vertical, 5)
                            .background(Color(.windowBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.sm)
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
            refreshAPIKeyState()
            isTextFieldFocused = true
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            refreshAPIKeyState()
        }
        .onReceive(NotificationCenter.default.publisher(for: .apiKeyManagerDidChange)) { _ in
            refreshAPIKeyState()
        }
        .onReceive(daemonClient.$isConnected) { _ in
            refreshAPIKeyState()
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

    private func refreshAPIKeyState() {
        hasAPIKey = APIKeyManager.getKey() != nil || daemonClient.isConnected
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
            var projectedCount = attachments.count
            var projectedBytes = attachments.reduce(0) { $0 + $1.sizeBytes }

            for url in urls {
                if projectedCount >= Self.maxAttachmentCount {
                    errors.append("You can attach up to \(Self.maxAttachmentCount) files per message.")
                    break
                }

                do {
                    let attachment = try TaskAttachment.fromFileURL(url)
                    if projectedBytes + attachment.sizeBytes > Self.maxTotalAttachmentBytes {
                        errors.append("Total attachment size cannot exceed 50MB per message.")
                        continue
                    }
                    newAttachments.append(attachment)
                    projectedCount += 1
                    projectedBytes += attachment.sizeBytes
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
            if attachments.count >= Self.maxAttachmentCount {
                attachmentError = "You can attach up to \(Self.maxAttachmentCount) files per message."
                return
            }

            let projectedBytes = attachments.reduce(0) { $0 + $1.sizeBytes } + data.count
            if projectedBytes > Self.maxTotalAttachmentBytes {
                attachmentError = "Total attachment size cannot exceed 50MB per message."
                return
            }

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

#Preview {
    TaskInputView(onSubmit: { _ in }, daemonClient: DaemonClient())
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
