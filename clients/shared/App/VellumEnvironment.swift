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
    ///
    /// When `VELLUM_ENVIRONMENT` is set, that value is used directly.
    /// When unset, iOS Simulator builds default to `.local` so that
    /// developers get localhost without needing to regenerate the
    /// Xcode project from `project.yml` after every pull.  All other
    /// targets (device, release, macOS) default to `.production`.
    public static let current: VellumEnvironment = {
        let raw = ProcessInfo.processInfo.environment["VELLUM_ENVIRONMENT"]
        if let raw {
            // Env var is explicitly set — use it, falling back to
            // .production for unrecognised values (e.g. typos).
            return VellumEnvironment(rawValue: raw) ?? .production
        }
        // Env var is absent entirely.
        #if targetEnvironment(simulator)
        return .local
        #else
        return .production
        #endif
    }()

    /// Resolve from an arbitrary environment dictionary (for testability).
    public static func resolve(from environment: [String: String]) -> VellumEnvironment {
        if let raw = environment["VELLUM_ENVIRONMENT"],
           let env = VellumEnvironment(rawValue: raw) {
            return env
        }
        return .production
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

    /// The current resolved platform URL.
    ///
    /// Resolution order:
    /// 1. `VELLUM_PLATFORM_URL` environment variable (explicit override)
    /// 2. `VELLUM_ENVIRONMENT`-based canonical URL
    public static var resolvedPlatformURL: String {
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["VELLUM_PLATFORM_URL"] {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = trimmed.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            if !normalized.isEmpty { return normalized }
        }
        return current.platformURL
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
