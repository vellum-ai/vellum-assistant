import Foundation

/// The type of media embed that should be rendered for a URL.
public enum MediaEmbedIntent: Equatable, Sendable {
    case image(url: URL)
    case video(provider: String, videoID: String, embedURL: URL)
}

/// Snapshot of user-facing settings that gate media embed resolution.
public struct MediaEmbedResolverSettings: Sendable {
    public let enabled: Bool
    public let enabledSince: Date?
    public let allowedDomains: [String]

    public init(enabled: Bool, enabledSince: Date?, allowedDomains: [String]) {
        self.enabled = enabled
        self.enabledSince = enabledSince
        self.allowedDomains = allowedDomains
    }
}

/// Result of parsing a video URL into its constituent parts.
public struct VideoParseResult: Sendable {
    public let videoID: String
    public let provider: String
    public let embedURL: URL

    public init(videoID: String, provider: String, embedURL: URL) {
        self.videoID = videoID
        self.provider = provider
        self.embedURL = embedURL
    }
}

/// Classification of a URL's image status based on file extension.
public enum ImageURLClassification: Sendable {
    case image
    case notImage
    case unknown
}
