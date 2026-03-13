import Foundation

/// Builds publicly-accessible thumbnail URLs for supported video providers.
///
/// YouTube thumbnails are served from `img.youtube.com` and require no API
/// key. Other providers may be added as static URL patterns become available.
public enum VideoThumbnailURL {

    /// Returns a thumbnail URL for the given provider and video ID, or nil
    /// if the provider doesn't support static thumbnail URLs.
    public static func thumbnailURL(provider: String, videoID: String) -> URL? {
        switch provider.lowercased() {
        case "youtube":
            // hqdefault is 480×360 and always available (maxresdefault may 404).
            return URL(string: "https://img.youtube.com/vi/\(videoID)/hqdefault.jpg")
        default:
            return nil
        }
    }
}
