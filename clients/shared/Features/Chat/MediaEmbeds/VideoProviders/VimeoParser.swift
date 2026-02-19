import Foundation

/// Parses Vimeo URLs in various formats and produces a canonical embed URL.
///
/// Supported patterns:
/// - `vimeo.com/VIDEO_ID`                        (standard)
/// - `www.vimeo.com/VIDEO_ID`                    (www subdomain)
/// - `player.vimeo.com/video/VIDEO_ID`           (player embed)
/// - `vimeo.com/channels/CHANNEL/VIDEO_ID`       (channel)
/// - `vimeo.com/groups/GROUP/videos/VIDEO_ID`    (group)
///
/// Only `https` URLs are accepted. Video IDs must be numeric.
public enum VimeoParser {

    private static let vimeoHosts: Set<String> = [
        "vimeo.com",
        "www.vimeo.com",
        "player.vimeo.com"
    ]

    public static func parse(_ url: URL) -> VideoParseResult? {
        guard url.scheme?.lowercased() == "https" else { return nil }

        guard let host = url.host?.lowercased() else { return nil }
        guard vimeoHosts.contains(host) else { return nil }

        let videoID: String?

        if host == "player.vimeo.com" {
            videoID = parsePlayerURL(url)
        } else {
            videoID = parseStandardURL(url)
        }

        guard let id = videoID, !id.isEmpty else { return nil }

        // Vimeo video IDs are strictly numeric
        guard id.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }

        guard let embedURL = URL(string: "https://player.vimeo.com/video/\(id)") else {
            return nil
        }

        return VideoParseResult(
            videoID: id,
            provider: "vimeo",
            embedURL: embedURL
        )
    }

    // MARK: - Private helpers

    /// Extracts the video ID from `player.vimeo.com/video/VIDEO_ID`.
    private static func parsePlayerURL(_ url: URL) -> String? {
        let path = url.path
        let prefix = "/video/"
        guard path.hasPrefix(prefix) else { return nil }
        let id = String(path.dropFirst(prefix.count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return id.isEmpty ? nil : id
    }

    /// Extracts the video ID from standard vimeo.com URL patterns:
    /// `/VIDEO_ID`, `/channels/NAME/VIDEO_ID`, `/groups/NAME/videos/VIDEO_ID`.
    private static func parseStandardURL(_ url: URL) -> String? {
        let components = url.pathComponents.filter { $0 != "/" }
        guard !components.isEmpty else { return nil }

        // /channels/NAME/VIDEO_ID
        if components.count >= 3 && components[0] == "channels" {
            return components[2]
        }

        // /groups/NAME/videos/VIDEO_ID
        if components.count >= 4 && components[0] == "groups" && components[2] == "videos" {
            return components[3]
        }

        // /VIDEO_ID (single path component, must be numeric — checked by caller)
        if components.count == 1 {
            return components[0]
        }

        return nil
    }
}
