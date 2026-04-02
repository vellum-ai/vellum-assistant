import Foundation

public enum ImageURLClassification {
    case image
    case notImage
    case unknown
}

/// Classifies URLs as image candidates based purely on file extension.
///
/// This is the first stage of image detection in the media-embed pipeline.
/// Only truly extensionless URLs return `.unknown` (triggering the MIME-probe
/// fallback); URLs with a non-image extension return `.notImage`.
public enum ImageURLClassifier {

    private static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "svg",
        "bmp", "ico", "tiff", "tif", "avif", "heic", "heif"
    ]

    public static func classify(_ url: URL) -> ImageURLClassification {
        // Only allow https for security.
        guard url.scheme?.lowercased() == "https" else {
            return .notImage
        }

        // Strip query and fragment by extracting just the path.
        let path = url.path

        // Find the last path component and check for a dot-separated extension.
        let lastComponent = (path as NSString).lastPathComponent
        guard let dotIndex = lastComponent.lastIndex(of: ".") else {
            return .unknown
        }

        let ext = String(lastComponent[lastComponent.index(after: dotIndex)...]).lowercased()

        // Empty extension (path ends with ".") is not recognizable.
        guard !ext.isEmpty else {
            return .unknown
        }

        if imageExtensions.contains(ext) {
            return .image
        }

        // Has a non-image extension — no need for a MIME probe.
        return .notImage
    }
}
