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

    /// The Vellum platform API base URL for this environment.
    /// Used by Apple Containers and other platform-facing services.
    /// Note: `local` and `dev` both target the dev platform.
    public var platformURL: String {
        switch self {
        case .production:
            return "https://platform.vellum.ai"
        case .staging:
            return "https://staging-platform.vellum.ai"
        case .test:
            return "https://test-platform.vellum.ai"
        case .local, .dev:
            return "https://dev-platform.vellum.ai"
        }
    }

    /// The auth/sign-in base URL for this environment.
    /// Differs from `platformURL` for `local` — auth targets localhost
    /// so the simulator and local dev builds use the local sign-up flow.
    public var authBaseURL: String {
        switch self {
        case .local:
            return "http://localhost:8000"
        case .production:
            return "https://platform.vellum.ai"
        case .staging:
            return "https://staging-platform.vellum.ai"
        case .test:
            return "https://test-platform.vellum.ai"
        case .dev:
            return "https://dev-platform.vellum.ai"
        }
    }
}
