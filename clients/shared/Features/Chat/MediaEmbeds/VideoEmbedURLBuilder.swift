import Foundation

/// Builds provider-specific embed URLs with playback parameters.
///
/// The parsers (`YouTubeParser`, `VimeoParser`, `LoomParser`) extract video IDs
/// and produce bare embed URLs. This builder adds player query parameters
/// (autoplay, rel suppression, etc.) that are provider-specific.
public enum VideoEmbedURLBuilder {

    public static func buildEmbedURL(provider: String, videoID: String) -> URL? {
        switch provider.lowercased() {
        case "youtube":
            return URL(string: "https://www.youtube.com/embed/\(videoID)?autoplay=1&rel=0")
        case "vimeo":
            return URL(string: "https://player.vimeo.com/video/\(videoID)?autoplay=1")
        case "loom":
            return URL(string: "https://www.loom.com/embed/\(videoID)?autoplay=1")
        default:
            return nil
        }
    }
}
