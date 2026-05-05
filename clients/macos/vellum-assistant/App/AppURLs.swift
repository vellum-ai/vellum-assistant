import Foundation
import VellumAssistantShared

/// Centralized URLs the macOS app links out to.
///
/// The docs base URL can be overridden at runtime via the `VELLUM_DOCS_BASE_URL`
/// environment variable (e.g. for staging or local docs servers). Falls back to
/// the production docs site.
///
/// Pattern parallels the assistant's `src/config/env.ts` — a single source of
/// truth, accessed via static getters rather than scattered string literals.
public enum AppURLs {
    /// Default base URL for Vellum docs. Used when no env var override is set.
    public static let defaultDocsBaseURL = "https://www.vellum.ai/docs"

    /// Base URL for Vellum docs. Honors `VELLUM_DOCS_BASE_URL` if set, otherwise
    /// returns `defaultDocsBaseURL`. Trailing slashes are stripped so callers can
    /// safely append paths with `/`.
    ///
    /// The env override is validated: it must parse as an absolute http(s) URL
    /// with a non-nil host. Malformed values fall back to `defaultDocsBaseURL`
    /// to prevent downstream force-unwraps in `docsURL(...)` from crashing.
    public static var docsBaseURL: String {
        let raw = ProcessInfo.processInfo.environment["VELLUM_DOCS_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let candidate = raw, !candidate.isEmpty else {
            return defaultDocsBaseURL
        }
        let normalized = candidate.hasSuffix("/") ? String(candidate.dropLast()) : candidate
        // Reject the override if it isn't a parseable absolute http(s) URL, or if
        // it contains a query string or fragment. The contract is "base URL must
        // be scheme://host[/path]" — a query or fragment would be silently
        // clobbered or pasted into the middle of the URL by the docsURL helpers.
        // This prevents downstream force-unwraps from crashing on malformed values.
        guard
            let url = URL(string: normalized),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            url.host != nil,
            url.query == nil,
            url.fragment == nil
        else {
            return defaultDocsBaseURL
        }
        return normalized
    }

    // MARK: - Concrete docs URLs

    /// Pricing docs page — linked from the Billing settings tab and the
    /// Models & Services tab pricing banner.
    public static var pricingDocs: URL {
        docsURL(path: "/pricing")
    }

    /// Hosting options docs — linked from the API key onboarding step.
    public static var hostingOptionsDocs: URL {
        docsURL(path: "/hosting-options")
    }

    /// Terms of Use docs — linked from the onboarding ToS consent.
    public static var termsOfUseDocs: URL {
        docsURL(path: "/vellum-terms-of-use")
    }

    /// Privacy Policy docs — linked from the onboarding ToS consent.
    public static var privacyPolicyDocs: URL {
        docsURL(path: "/privacy-policy")
    }

    /// AI Data Sharing Policy docs — linked from the onboarding AI data consent checkbox.
    public static var dataSharingDocs: URL {
        docsURL(path: "/data-sharing")
    }

    // MARK: - Web app URLs

    /// Web app billing settings page — opened from the Settings → Billing tab's
    /// "Adjust Plan" and "Configure Auto Top Ups" buttons (both gated by the
    /// `pro-plan-adjust` feature flag). Resolves to the Next.js web app at
    /// `<webURL>/assistant/settings/billing` for the current build environment.
    ///
    /// If `VELLUM_WEB_URL` is set but malformed (no scheme/host, non-http(s),
    /// or contains a query/fragment), falls back to the canonical environment
    /// URL via `VellumEnvironment.current.webURL`. Query/fragment are rejected
    /// because string-concatenating a literal path onto `https://host?foo=bar`
    /// would produce `https://host?foo=bar/assistant/settings/billing` — the
    /// path gets absorbed into the query string. Mirrors the validation in
    /// `docsBaseURL` above. Force-unwrap on the final `URL(string:)` is safe
    /// because both candidate base strings are validated/known-good and the
    /// path is a literal.
    public static var billingSettings: URL {
        let candidate = VellumEnvironment.resolvedWebURL
        let base: String
        if let url = URL(string: candidate),
           let scheme = url.scheme?.lowercased(),
           (scheme == "http" || scheme == "https"),
           url.host != nil,
           url.query == nil,
           url.fragment == nil {
            base = candidate
        } else {
            base = VellumEnvironment.current.webURL
        }
        return URL(string: "\(base)/assistant/settings/billing")!
    }

    // MARK: - Source repository

    /// Public source repository — linked from the Settings "Open Source" card
    /// and the About panel's "View on GitHub" entry. Force-unwrap is safe: the
    /// literal is a known-valid absolute URL.
    public static let repositoryURL = URL(string: "https://github.com/vellum-ai/vellum-assistant")!

    // MARK: - Helpers

    /// Build a docs URL by appending a path to the (possibly env-overridden) base.
    /// Force-unwrap is safe: `docsBaseURL` is always a valid URL string and `path`
    /// is a literal path component supplied at the call site.
    public static func docsURL(path: String) -> URL {
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        return URL(string: "\(docsBaseURL)\(normalizedPath)")!
    }

    /// Build a docs URL with UTM tracking query parameters. Used by the Help menu
    /// Documentation entry to attribute traffic to the macOS app.
    public static func docsURL(
        path: String = "",
        utmSource: String,
        utmMedium: String
    ) -> URL {
        let normalizedPath = path.isEmpty || path.hasPrefix("/") ? path : "/\(path)"
        var components = URLComponents(string: "\(docsBaseURL)\(normalizedPath)")!
        components.queryItems = [
            URLQueryItem(name: "utm_source", value: utmSource),
            URLQueryItem(name: "utm_medium", value: utmMedium),
        ]
        return components.url!
    }
}
