import Foundation

/// Reads the build-time `VELLUM_ENVIRONMENT` value embedded in Info.plist
/// via `LSEnvironment` and derives environment-dependent configuration.
///
/// Values: `local`, `dev`, `test`, `staging`, `production`.
/// Falls back to `"production"` when the variable is unset (e.g. in unit
/// tests or when launched outside the normal build pipeline).
enum VellumEnvironment: String {
    case local
    case dev
    case test
    case staging
    case production

    /// The current environment, read once from `ProcessInfo`.
    static let current: VellumEnvironment = {
        let raw = ProcessInfo.processInfo.environment["VELLUM_ENVIRONMENT"] ?? "production"
        return VellumEnvironment(rawValue: raw) ?? .production
    }()

    /// The Vellum platform API base URL for this environment.
    var platformURL: String {
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
}
