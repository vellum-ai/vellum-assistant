import Foundation

/// Builds the initial URLRequest for inline video embeds.
///
/// YouTube started rejecting embedded player loads without an identifying
/// `Referer` header in July 2025 (`onError` code 153). Native app webviews
/// don't naturally provide a page referrer, so we attach a stable HTTPS
/// referer for YouTube requests to satisfy that requirement.
public enum VideoEmbedRequestBuilder {
    /// Stable HTTPS referer used to identify Vellum-hosted embeds.
    public static let defaultReferer = "https://vellum.ai"

    public static func buildRequest(
        url: URL,
        provider: String,
        referer: String? = defaultReferer
    ) -> URLRequest {
        var request = URLRequest(url: url)

        guard provider.caseInsensitiveCompare("youtube") == .orderedSame,
              let normalizedReferer = normalizeReferer(referer) else {
            return request
        }

        request.setValue(normalizedReferer, forHTTPHeaderField: "Referer")
        return request
    }

    private static func normalizeReferer(_ referer: String?) -> String? {
        guard let trimmed = referer?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        return trimmed
    }
}
