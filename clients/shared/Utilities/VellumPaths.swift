import Foundation

/// Env-aware filesystem path helpers for client-owned state. Mirrors
/// `cli/src/lib/environments/paths.ts` so the Swift client and the TS
/// daemon/CLI produce byte-identical paths for production users while
/// sharing the same convention for non-production environments.
///
/// **Production is grandfathered**: every getter returns the legacy
/// `~/.vellum/...` path (or the existing `~/.config/vellum/...` path for
/// things that were already XDG-compliant). No migration for existing
/// installs.
///
/// **Non-production environments** use env-scoped XDG paths
/// (`$XDG_CONFIG_HOME/vellum-<env>/...`). These are dormant today — no
/// build currently bakes a non-production `VELLUM_ENVIRONMENT` into
/// `Info.plist` for end users.
///
/// Production code reads `VellumPaths.current` (cached singleton). Tests
/// construct their own `VellumPaths` with explicit roots so they don't
/// depend on the surrounding process state.
public struct VellumPaths {
    public let environment: VellumEnvironment
    public let homeDirectory: URL
    public let xdgConfigHome: URL

    /// Resolved path bundle for the current process environment.
    ///
    /// `NSHomeDirectory()` is used intentionally to match the existing
    /// convention in `LockfilePaths.swift` (for unsandboxed macOS apps,
    /// this is equivalent to `FileManager.default.homeDirectoryForCurrentUser`).
    public static let current: VellumPaths = {
        VellumPaths(
            environment: .current,
            homeDirectory: URL(fileURLWithPath: NSHomeDirectory()),
            xdgConfigHome: Self.resolveXdgConfigHome()
        )
    }()

    public init(
        environment: VellumEnvironment,
        homeDirectory: URL,
        xdgConfigHome: URL
    ) {
        self.environment = environment
        self.homeDirectory = homeDirectory
        self.xdgConfigHome = xdgConfigHome
    }

    // MARK: - Path getters

    /// `~/.config/vellum/` for production, `~/.config/vellum-<env>/` otherwise.
    public var configDir: URL {
        let dirName: String
        if environment == .production {
            dirName = "vellum"
        } else {
            dirName = "vellum-\(environment.rawValue)"
        }
        return xdgConfigHome.appendingPathComponent(dirName)
    }

    /// Shared with the TypeScript daemon.
    public var deviceIdFile: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(".vellum/device.json")
        }
        return configDir.appendingPathComponent("device.json")
    }

    /// macOS-client-owned; not read by the daemon.
    public var signingKeyFile: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(
                ".vellum/protected/app-signing-key"
            )
        }
        return configDir.appendingPathComponent("app-signing-key")
    }

    /// macOS-client-owned; not read by the daemon.
    public var credentialsDir: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(
                ".vellum/protected/credentials"
            )
        }
        return configDir.appendingPathComponent("credentials")
    }

    /// Shared with the daemon. Always XDG-rooted (no legacy branch).
    public var platformTokenFile: URL {
        configDir.appendingPathComponent("platform-token")
    }

    /// Priority order: current name first, legacy fallback second.
    /// Production returns both; non-prod returns only the current.
    public var lockfileCandidates: [URL] {
        if environment == .production {
            return [
                homeDirectory.appendingPathComponent(".vellum.lock.json"),
                homeDirectory.appendingPathComponent(".vellum.lockfile.json"),
            ]
        }
        return [configDir.appendingPathComponent("lockfile.json")]
    }

    // MARK: - Internals

    private static func resolveXdgConfigHome() -> URL {
        if let raw = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty,
            // XDG Base Directory spec requires absolute paths; relative values
            // are ignored for parity with the TypeScript env package which
            // also doesn't resolve them.
            raw.hasPrefix("/")
        {
            return URL(fileURLWithPath: raw)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".config")
    }
}
