import Foundation

/// Resolves the runtime HTTP base URL for the local daemon.
/// Used to construct URLs like `\(RuntimeHTTP.baseURL)/v1/attachments/\(id)/content`.
enum RuntimeHTTP {
    /// Base URL for the local daemon's HTTP server (e.g., "http://localhost:7821").
    static var baseURL: String {
        let port = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "7821"
        return "http://localhost:\(port)"
    }

    /// Construct a URL for streaming attachment content (video, etc.).
    static func attachmentContentURL(attachmentId: String) -> URL? {
        URL(string: "\(baseURL)/v1/attachments/\(attachmentId)/content")
    }
}
