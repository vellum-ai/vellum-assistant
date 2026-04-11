import Foundation

/// Runtime environment identifier derived from the `VELLUM_ENVIRONMENT` value
/// embedded at build time. See AGENTS.md "Build Environment" for the full matrix.
///
/// Values: `local`, `dev`, `test`, `staging`, `production`.
/// Falls back to `.production` when the variable is unset (e.g. in unit
/// tests or when launched outside the normal build pipeline).
public enum VellumEnvironment: String {
    case local
    case dev
    case test
    case staging
    case production

    /// The current environment, read once from `ProcessInfo`.
    public static let current: VellumEnvironment = {
        let raw = ProcessInfo.processInfo.environment["VELLUM_ENVIRONMENT"] ?? "production"
        return VellumEnvironment(rawValue: raw) ?? .production
    }()

    /// Resolve from an arbitrary environment dictionary (for testability).
    public static func resolve(from environment: [String: String]) -> VellumEnvironment {
        let raw = environment["VELLUM_ENVIRONMENT"] ?? "production"
        return VellumEnvironment(rawValue: raw) ?? .production
    }

    /// Human-readable label for display in the About panel.
    /// Returns `nil` for production so callers can omit the label entirely.
    public var displayLabel: String? {
        switch self {
        case .local: return "Local"
        case .dev: return "Dev"
        case .test: return "Test"
        case .staging: return "Staging"
        case .production: return nil
        }
    }

    /// The canonical Vellum platform API base URL for this environment.
    public var platformURL: String {
        switch self {
        case .local:
            return "http://localhost:8000"
        case .dev:
            return "https://dev-platform.vellum.ai"
        case .test:
            return "https://test-platform.vellum.ai"
        case .staging:
            return "https://staging-platform.vellum.ai"
        case .production:
            return "https://platform.vellum.ai"
        }
    }

    /// Resolve the platform URL from an environment dictionary.
    ///
    /// Resolution order:
    /// 1. `VELLUM_PLATFORM_URL` environment variable (explicit override)
    /// 2. `VELLUM_ENVIRONMENT`-based canonical URL
    public static func resolvePlatformURL(from environment: [String: String]) -> String {
        if let raw = environment["VELLUM_PLATFORM_URL"] {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            if !normalized.isEmpty { return normalized }
        }
        return resolve(from: environment).platformURL
    }

    /// The current resolved platform URL, read once from `ProcessInfo`.
    /// Checks `VELLUM_PLATFORM_URL` first, then falls back to the
    /// environment-based canonical URL.
    public static var resolvedPlatformURL: String {
        resolvePlatformURL(from: ProcessInfo.processInfo.environment)
    }

    /// The platform URL to inject into containers (Docker, Apple Containers).
    /// For `local`, containers can't reach `localhost` on the host, so we
    /// fall back to the remote dev platform.
    public var containerPlatformURL: String {
        switch self {
        case .local:
            return "https://dev-platform.vellum.ai"
        default:
            return platformURL
        }
    }
}
