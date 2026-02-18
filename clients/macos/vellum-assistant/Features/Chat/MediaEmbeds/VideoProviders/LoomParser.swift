import Foundation

/// Parses Loom URLs and produces a canonical embed URL.
///
/// Supported patterns:
/// - `loom.com/share/VIDEO_ID`  (with optional www subdomain)
/// - `loom.com/embed/VIDEO_ID`  (with optional www subdomain)
///
/// Only `https` URLs are accepted.
enum LoomParser {

    private static let loomHosts: Set<String> = [
        "loom.com",
        "www.loom.com"
    ]

    static func parse(_ url: URL) -> VideoParseResult? {
        guard url.scheme?.lowercased() == "https" else { return nil }

        guard let host = url.host?.lowercased() else { return nil }
        guard loomHosts.contains(host) else { return nil }

        let pathComponents = url.pathComponents.filter { $0 != "/" }

        // Expect ["share"|"embed", VIDEO_ID]
        guard pathComponents.count == 2,
              ["share", "embed"].contains(pathComponents[0]),
              !pathComponents[1].isEmpty else { return nil }

        let videoID = pathComponents[1]

        guard let embedURL = URL(string: "https://www.loom.com/embed/\(videoID)") else {
            return nil
        }

        return VideoParseResult(
            videoID: videoID,
            provider: "loom",
            embedURL: embedURL
        )
    }
}
