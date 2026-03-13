import Foundation

public struct VideoParseResult {
    public let videoID: String
    public let provider: String
    public let embedURL: URL

    public init(videoID: String, provider: String, embedURL: URL) {
        self.videoID = videoID
        self.provider = provider
        self.embedURL = embedURL
    }
}

/// Parses YouTube URLs in various formats and produces a canonical embed URL.
///
/// Supported patterns:
/// - `youtube.com/watch?v=ID`  (with optional www/m/music subdomain)
/// - `youtu.be/ID`             (short-link)
/// - `youtube.com/shorts/ID`
/// - `youtube.com/embed/ID`
/// - `music.youtube.com/watch?v=ID`
///
/// Only `https` URLs are accepted.
public enum YouTubeParser {

    private static let youtubeHosts: Set<String> = [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com",
    ]

    public static func parse(_ url: URL) -> VideoParseResult? {
        guard url.scheme?.lowercased() == "https" else { return nil }

        guard let host = url.host?.lowercased() else { return nil }

        let videoID: String?

        if host == "youtu.be" {
            videoID = parseShortLink(url)
        } else if youtubeHosts.contains(host) {
            videoID = parseStandardURL(url)
        } else {
            return nil
        }

        guard let id = videoID, !id.isEmpty else { return nil }

        // YouTube video IDs are ASCII base64url: [A-Za-z0-9_-].
        // Use an explicit set instead of .alphanumerics which includes Unicode.
        let validIDCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard id.unicodeScalars.allSatisfy({ validIDCharacters.contains($0) }) else { return nil }

        guard let embedURL = URL(string: "https://www.youtube.com/embed/\(id)") else {
            return nil
        }

        return VideoParseResult(
            videoID: id,
            provider: "youtube",
            embedURL: embedURL
        )
    }

    // MARK: - Private helpers

    /// Extracts the video ID from a `youtu.be/VIDEO_ID` short link.
    private static func parseShortLink(_ url: URL) -> String? {
        let path = url.path
        guard path.count > 1 else { return nil }

        // Drop the leading "/" to get the video ID. Strip any trailing slash.
        let id = String(path.dropFirst()).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return id.isEmpty ? nil : id
    }

    /// Extracts the video ID from standard youtube.com URL patterns:
    /// `/watch?v=ID`, `/shorts/ID`, `/embed/ID`.
    private static func parseStandardURL(_ url: URL) -> String? {
        let path = url.path

        // /shorts/VIDEO_ID or /embed/VIDEO_ID
        for prefix in ["/shorts/", "/embed/"] {
            if path.hasPrefix(prefix) {
                let id = String(path.dropFirst(prefix.count))
                    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                return id.isEmpty ? nil : id
            }
        }

        // /watch?v=VIDEO_ID
        if path == "/watch" || path == "/watch/" {
            guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let queryItems = components.queryItems else {
                return nil
            }
            return queryItems.first(where: { $0.name == "v" })?.value
        }

        return nil
    }
}
