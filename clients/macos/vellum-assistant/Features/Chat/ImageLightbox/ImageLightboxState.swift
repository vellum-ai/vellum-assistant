import AppKit

/// Data model for the in-app image lightbox preview.
struct ImageLightboxState {
    /// The image to display (may be a thumbnail while full-res loads).
    let image: NSImage
    /// Original filename for display and save actions.
    let filename: String
    /// Base64-encoded image data for copy/save at full resolution.
    let base64Data: String?
    /// Attachment ID for fetching full-res data on demand (lazy-loaded attachments).
    let lazyAttachmentId: String?
    /// Full-resolution image populated after lazy fetch completes.
    var fullResImage: NSImage?
    /// Whether a lazy-load fetch is in progress.
    var isLoadingFullRes: Bool

    /// The best available image — full-res if loaded, otherwise the original.
    var displayImage: NSImage {
        fullResImage ?? image
    }
}
