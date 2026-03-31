#if os(macOS)
import Foundation
import SwiftUI
import UniformTypeIdentifiers

// MARK: - DropActions

/// Groups all drop-related callbacks and state needed by the composer drop handler.
struct DropActions {
    /// Called with resolved file URLs after a drop completes.
    var onDropFiles: ([URL]) -> Void
    /// Called with raw image data (and optional suggested name) for providers without a backing file.
    var onDropImageData: (Data, String?) -> Void
    /// Called immediately when a drop begins, before async provider loading starts.
    var onDropStarted: (() -> Void)?
    /// Called after all providers have resolved and individual attachment calls have taken over.
    var onDropEnded: (() -> Void)?
    /// Binding to the drop-targeted overlay state.
    var isDropTargeted: Binding<Bool>
    /// Binding that tracks whether the user is dragging an internally-rendered image
    /// (e.g. to Finder/Desktop), which should be rejected as an upload.
    var isDraggingInternalImage: Binding<Bool>
    /// Called when an internal image drag is rejected so the caller can perform
    /// cleanup (e.g. removing drag-end monitors) that would otherwise be skipped
    /// by the early return.
    var onInternalDragRejected: (() -> Void)?

    /// A no-op default suitable for use as an EnvironmentKey default value.
    static let noop = DropActions(
        onDropFiles: { _ in },
        onDropImageData: { _, _ in },
        onDropStarted: nil,
        onDropEnded: nil,
        isDropTargeted: .constant(false),
        isDraggingInternalImage: .constant(false),
        onInternalDragRejected: nil
    )
}

// MARK: - EnvironmentKey

private struct DropActionsKey: EnvironmentKey {
    static let defaultValue: DropActions = .noop
}

extension EnvironmentValues {
    var dropActions: DropActions {
        get { self[DropActionsKey.self] }
        set { self[DropActionsKey.self] = newValue }
    }
}

// MARK: - ComposerDropHandler

/// Utility that extracts the drop-handling logic from ChatView into a reusable static method.
enum ComposerDropHandler {

    /// Handle dropped items — supports both file URLs and raw image data.
    /// File URLs are preferred (preserves original filenames); raw image data
    /// is used as a fallback for providers without a backing file (e.g. screenshot
    /// thumbnails or images dragged from certain apps).
    static func handleDrop(providers: [NSItemProvider], actions: DropActions) -> Bool {
        // Reset overlay immediately — SwiftUI's isTargeted binding may not
        // reset reliably when AppKit's NSDraggingDestination (e.g. the
        // NSTextView inside the composer) intercepts the drag session.
        actions.isDropTargeted.wrappedValue = false

        // Reject drops from internal image drags — the user is dragging an
        // assistant-rendered image to Finder/Desktop, not uploading it back.
        if actions.isDraggingInternalImage.wrappedValue {
            actions.isDraggingInternalImage.wrappedValue = false
            actions.onInternalDragRejected?()
            return false
        }

        // Signal loading immediately so the "Processing…" chip appears without
        // waiting for NSItemProvider async callbacks to resolve.
        actions.onDropStarted?()

        var urls: [URL] = []
        var imageDataItems: [NSItemProvider] = []
        let group = DispatchGroup()

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let hasImageFallback = provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                    || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                    || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier)
                group.enter()
                _ = provider.loadObject(ofClass: URL.self) { url, error in
                    DispatchQueue.main.async {
                        if let url, FileManager.default.fileExists(atPath: url.path) {
                            urls.append(url)
                            group.leave()
                        } else if hasImageFallback {
                            let typeIdentifier: String
                            if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                                typeIdentifier = UTType.png.identifier
                            } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                                typeIdentifier = UTType.tiff.identifier
                            } else {
                                typeIdentifier = UTType.image.identifier
                            }
                            let suggestedName = provider.suggestedName
                            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                                DispatchQueue.main.async {
                                    if let data {
                                        actions.onDropImageData(data, suggestedName)
                                    } else if let url, url.isFileURL {
                                        // Image data load failed — fall back to
                                        // the file URL (may be a file promise).
                                        urls.append(url)
                                    }
                                    group.leave()
                                }
                            }
                        } else if let url, url.isFileURL {
                            // File URL doesn't exist on disk yet (e.g. file
                            // promises from Music.app, Voice Memos) and no
                            // image data fallback is available. Try the URL
                            // anyway — the attachment loader will report an
                            // error if the file is truly inaccessible.
                            urls.append(url)
                            group.leave()
                        } else {
                            group.leave()
                        }
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.png.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                imageDataItems.append(provider)
            }
        }

        for provider in imageDataItems {
            let typeIdentifier: String
            if provider.hasItemConformingToTypeIdentifier(UTType.png.identifier) {
                typeIdentifier = UTType.png.identifier
            } else if provider.hasItemConformingToTypeIdentifier(UTType.tiff.identifier) {
                typeIdentifier = UTType.tiff.identifier
            } else {
                typeIdentifier = UTType.image.identifier
            }

            let suggestedName = provider.suggestedName
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                DispatchQueue.main.async {
                    if let data {
                        actions.onDropImageData(data, suggestedName)
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) {
            if !urls.isEmpty { actions.onDropFiles(urls) }
            // End the external load now that all providers have resolved and
            // the individual addAttachment calls have taken over tracking.
            actions.onDropEnded?()
        }
        return true
    }
}
#endif
