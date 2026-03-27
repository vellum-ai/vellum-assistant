import Foundation
import os
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif

// MARK: - Attachments
// All implementation lives in ChatAttachmentManager.  These wrappers preserve
// the existing public API surface on ChatViewModel so every call site compiles
// without modification.

extension ChatViewModel {

    public func addAttachment(url: URL) {
        attachmentManager.addAttachment(url: url)
    }

    public func removeAttachment(id: String) {
        attachmentManager.removeAttachment(id: id)
    }

    public func addAttachmentFromPasteboard() {
        attachmentManager.addAttachmentFromPasteboard()
    }

    /// Add an attachment from raw image data (e.g. drag-and-drop, pasteboard).
    /// Converts TIFF to PNG if needed.
    public func addAttachment(imageData: Data, filename: String = "Dropped Image.png") {
        attachmentManager.addAttachment(imageData: imageData, filename: filename)
    }

    // MARK: - Image processing utilities

    /// Compress image data if it exceeds the size limit.
    /// Returns (compressedData, wasCompressed) tuple.
    static func compressImageIfNeeded(data: Data, maxSize: Int) -> (Data, Bool) {
        ChatAttachmentManager.compressImageIfNeeded(data: data, maxSize: maxSize)
    }
}
