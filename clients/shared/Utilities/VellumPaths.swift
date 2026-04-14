import Foundation

/// Env-aware filesystem path helpers for client-owned state. Mirrors
/// `cli/src/lib/environments/paths.ts` from the Phase 0 module so the Swift
/// client and the TypeScript daemon/CLI produce byte-identical paths for
/// production users while sharing the same convention for non-production
/// environments.
///
/// **Production is grandfathered**: every getter returns the legacy
/// `~/.vellum/...` path (or the existing `~/.config/vellum/...` path for
/// things that were already XDG-compliant). No migration is needed for
/// existing installs.
///
/// **Non-production environments** use env-scoped XDG paths
/// (`$XDG_CONFIG_HOME/vellum-<env>/...`). These are dormant today — no build
/// currently bakes a non-production `VELLUM_ENVIRONMENT` into `Info.plist`
/// for end users — and become live as the daemon-side phases land.
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
    /// `NSHomeDirectory()` is used intentionally here and in
    /// `resolveXdgConfigHome()` to match the existing convention across the
    /// codebase (`LockfilePaths.swift`, `SessionTokenManager.swift`). For
    /// **unsandboxed** macOS apps — the Vellum desktop app today — this is
    /// equivalent to `FileManager.default.homeDirectoryForCurrentUser`. If
    /// macOS app sandboxing is ever enabled, `NSHomeDirectory()` will
    /// return the sandbox container path instead of the real user home,
    /// which would move every path this struct produces. That migration
    /// would need to be coordinated with daemon-side reads (same files are
    /// shared: device.json, app-signing-key, credentials, platform-token,
    /// lockfile) and is out of scope until sandboxing becomes a target.
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

    /// Shared with the TypeScript daemon.
    public var deviceIdFile: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(".vellum/device.json")
        }
        return envScopedXdgDir.appendingPathComponent("device.json")
    }

    /// macOS-client-owned; not read by the daemon.
    public var signingKeyFile: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(
                ".vellum/protected/app-signing-key"
            )
        }
        return envScopedXdgDir.appendingPathComponent("app-signing-key")
    }

    /// macOS-client-owned; not read by the daemon.
    public var credentialsDir: URL {
        if environment == .production {
            return homeDirectory.appendingPathComponent(
                ".vellum/protected/credentials"
            )
        }
        return envScopedXdgDir.appendingPathComponent("credentials")
    }

    /// Shared with the daemon. Always XDG-rooted (no legacy branch).
    public var platformTokenFile: URL {
        envScopedXdgDir.appendingPathComponent("platform-token")
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
        return [envScopedXdgDir.appendingPathComponent("lockfile.json")]
    }

    // MARK: - Internals

    /// `~/.config/vellum/` for production, `~/.config/vellum-<env>/` otherwise.
    private var envScopedXdgDir: URL {
        let dirName: String
        if environment == .production {
            dirName = "vellum"
        } else {
            dirName = "vellum-\(environment.rawValue)"
        }
        return xdgConfigHome.appendingPathComponent(dirName)
    }

    private static func resolveXdgConfigHome() -> URL {
        if let raw = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
        {
            return URL(fileURLWithPath: raw)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".config")
    }
}
