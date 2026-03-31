import Foundation

/// The type of media embed that should be rendered for a URL.
public enum MediaEmbedIntent: Equatable {
    case image(url: URL)
    case video(provider: String, videoID: String, embedURL: URL)
}

/// Snapshot of user-facing settings that gate media embed resolution.
public struct MediaEmbedResolverSettings: Equatable {
    public let enabled: Bool
    public let enabledSince: Date?
    public let allowedDomains: [String]

    public init(enabled: Bool, enabledSince: Date?, allowedDomains: [String]) {
        self.enabled = enabled
        self.enabledSince = enabledSince
        self.allowedDomains = allowedDomains
    }
}

/// Assembles URL extraction, video parsing, image classification, and
/// domain allowlisting into a single pure resolution step.
///
/// The resolver is role-agnostic (works for both user and assistant
/// messages), deduplicates by canonical URL, and respects the feature
/// gate (`enabled` / `enabledSince`).
public enum MediaEmbedResolver {

    /// Video parsers tried in order for each extracted URL.
    private static let videoParsers: [(URL) -> VideoParseResult?] = [
        YouTubeParser.parse,
        VimeoParser.parse,
        LoomParser.parse,
    ]

    /// Resolves all media embed intents for a single chat message.
    ///
    /// Returns an empty array when the feature is disabled, when the
    /// message predates `enabledSince`, or when no embeddable URLs
    /// are found.
    ///
    /// Uses a two-stage image detection approach: first tries extension-based
    /// classification via `ImageURLClassifier`, then falls back to an async
    /// HTTP HEAD probe via `ImageMIMEProbe` for extensionless URLs.
    public static func resolve(
        message: ChatMessage,
        settings: MediaEmbedResolverSettings
    ) async -> [MediaEmbedIntent] {
        guard settings.enabled else { return [] }

        if let enabledSince = settings.enabledSince,
           message.timestamp < enabledSince {
            return []
        }

        let urls = await URLExtractionCache.shared.extractAllURLs(from: message.text)
        guard !urls.isEmpty else { return [] }

        var seen = Set<String>()

        // First pass: classify each URL synchronously where possible,
        // recording placeholder indices for URLs that need async probing.
        // This preserves the original URL source order in the final array.
        var intents: [MediaEmbedIntent?] = []
        var probeTargets: [(index: Int, url: URL)] = []

        for url in urls {
            if let videoResult = tryVideoParsers(url, allowedDomains: settings.allowedDomains) {
                let canonical = videoResult.embedURL.absoluteString
                guard !seen.contains(canonical) else { continue }
                seen.insert(canonical)
                intents.append(.video(
                    provider: videoResult.provider,
                    videoID: videoResult.videoID,
                    embedURL: videoResult.embedURL
                ))
                continue
            }

            let classification = ImageURLClassifier.classify(url)
            if classification == .image {
                let canonical = url.absoluteString
                guard !seen.contains(canonical) else { continue }
                seen.insert(canonical)
                intents.append(.image(url: url))
            } else if classification == .unknown {
                let canonical = url.absoluteString
                guard !seen.contains(canonical) else { continue }
                seen.insert(canonical)
                // Reserve a slot so probed images appear in source order.
                let placeholderIndex = intents.count
                intents.append(nil)
                probeTargets.append((index: placeholderIndex, url: url))
            }
        }

        // Second pass: probe extensionless URLs concurrently, then fill
        // placeholders. Concurrency is bounded by ImageMIMEProbe's semaphore.
        if !probeTargets.isEmpty {
            let probeResults: [String: ImageURLClassification] = await withTaskGroup(
                of: (String, ImageURLClassification).self
            ) { group in
                for (_, url) in probeTargets {
                    group.addTask {
                        let result = await ImageMIMEProbe.shared.probe(url)
                        return (url.absoluteString, result)
                    }
                }
                var map: [String: ImageURLClassification] = [:]
                for await (key, classification) in group {
                    map[key] = classification
                }
                return map
            }

            for (index, url) in probeTargets {
                if probeResults[url.absoluteString] == .image {
                    intents[index] = .image(url: url)
                }
            }
        }

        // Strip nil placeholders (probed URLs that were not images).
        return intents.compactMap { $0 }
    }

    // MARK: - Private helpers

    /// Tries each video parser against the URL. Returns the first
    /// successful result whose domain passes the allowlist, or nil.
    private static func tryVideoParsers(
        _ url: URL,
        allowedDomains: [String]
    ) -> VideoParseResult? {
        for parser in videoParsers {
            if let result = parser(url) {
                guard DomainAllowlistMatcher.isAllowed(url, allowedDomains: allowedDomains) else {
                    return nil
                }
                return result
            }
        }
        return nil
    }
}
