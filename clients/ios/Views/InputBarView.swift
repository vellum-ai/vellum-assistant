#if canImport(UIKit)
import os
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "InputBarView"
)

struct InputBarView: View {
    @Binding var text: String
    var isInputFocused: FocusState<Bool>.Binding
    let isGenerating: Bool
    let isCancelling: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    var viewModel: ChatViewModel

    @State private var showPhotosPicker = false
    @State private var showDocumentPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []

    var body: some View {
        VStack(spacing: 0) {
            AttachmentStripView(viewModel: viewModel)
            inputRow
        }
    }

    private var inputRow: some View {
        HStack(spacing: VSpacing.md) {
            VButton(
                label: "Attach file",
                iconOnly: VIcon.paperclip.rawValue,
                style: .ghost,
                action: { showPhotosPicker = true }
            )
            .contextMenu {
                Button {
                    showPhotosPicker = true
                } label: {
                    Label { Text("Photo Library") } icon: { VIconView(.image, size: 14) }
                }
                Button {
                    showDocumentPicker = true
                } label: {
                    Label { Text("Files") } icon: { VIconView(.folder, size: 14) }
                }
            }
            .photosPicker(
                isPresented: $showPhotosPicker,
                selection: $selectedPhotoItems,
                matching: .images
            )
            .fileImporter(
                isPresented: $showDocumentPicker,
                allowedContentTypes: [.item],
                allowsMultipleSelection: true
            ) { result in
                handleFileImportResult(result)
            }
            .onChange(of: selectedPhotoItems) { _, newItems in
                handlePhotoSelection(newItems)
            }

            TextField("Message...", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .padding(VSpacing.md)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .focused(isInputFocused)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: isInputFocused.wrappedValue ? 1.5 : 1)
                )
                .animation(VAnimation.fast, value: isInputFocused.wrappedValue)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase.opacity(0.12), lineWidth: 3)
                        .opacity(isInputFocused.wrappedValue ? 1 : 0)
                        .animation(VAnimation.fast, value: isInputFocused.wrappedValue)
                )
                .shadow(color: VColor.contentDefault.opacity(0.06), radius: 8, x: 0, y: 2)

            if isGenerating && !isCancelling {
                VButton(
                    label: "Stop generation",
                    iconOnly: VIcon.square.rawValue,
                    style: .primary,
                    action: onStop
                )
            } else {
                VButton(
                    label: "Send message",
                    iconOnly: VIcon.arrowUp.rawValue,
                    style: .primary,
                    action: {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onSend()
                    }
                )
                .disabled(!canSend)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
    }

    private var canSend: Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = !viewModel.pendingAttachments.isEmpty
        return (hasText || hasAttachments) && !isGenerating && !viewModel.isLoadingAttachment
    }

    private func handlePhotoSelection(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        selectedPhotoItems = []
        for item in items {
            item.loadTransferable(type: Data.self) { result in
                switch result {
                case .success(let data):
                    guard let data else { return }
                    Task { @MainActor in
                        viewModel.addAttachment(imageData: data, filename: "Photo.jpeg")
                    }
                case .failure(let error):
                    log.error("Failed to load photo: \(error.localizedDescription)")
                    Task { @MainActor in
                        viewModel.errorText = "Could not load photo."
                    }
                }
            }
        }
    }

    private func handleFileImportResult(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            for url in urls {
                let didStartAccessing = url.startAccessingSecurityScopedResource()
                defer {
                    if didStartAccessing { url.stopAccessingSecurityScopedResource() }
                }
                viewModel.addAttachment(url: url)
            }
        case .failure(let error):
            log.error("File import failed: \(error.localizedDescription)")
            viewModel.errorText = "Could not import file."
        }
    }
}
#endif
