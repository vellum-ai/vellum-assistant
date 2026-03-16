import Foundation
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "AppleContainers")

/// The set of reasons Apple Containers may be unavailable on the current system.
///
/// The gate checks these in priority order: feature flag first, then runtime
/// capability checks. Multiple reasons can coexist, but `featureFlagDisabled`
/// always takes precedence and short-circuits further checks when the flag is
/// off.
public enum AppleContainersUnavailableReason: Equatable, CustomStringConvertible {
    /// The `apple_containers_enabled` feature flag is off (the default).
    case featureFlagDisabled
    /// The host OS is below the minimum required for Apple Containerization.
    /// Apple Containerization requires macOS 15 (Sequoia) or later.
    case osVersionTooLow
    /// The embedded apple-containers runtime bundle was not found inside the
    /// main application bundle. This bundle is only embedded in builds that
    /// explicitly include it.
    case runtimeBundleNotFound
    /// The runtime loader reported that the containerization toolchain is not
    /// ready (e.g. missing helper binaries or entitlements not granted).
    case runtimeLoaderNotReady

    public var description: String {
        switch self {
        case .featureFlagDisabled:
            return "Apple Containers feature flag is disabled"
        case .osVersionTooLow:
            return "Apple Containers requires macOS 15 or later"
        case .runtimeBundleNotFound:
            return "Apple Containers runtime bundle not found in app bundle"
        case .runtimeLoaderNotReady:
            return "Apple Containers runtime loader is not ready"
        }
    }
}

/// The resolved availability of Apple Containers for the current session.
public enum AppleContainersAvailability: Equatable {
    /// Apple Containers is fully available — the flag is on and all runtime
    /// capability checks passed.
    case available
    /// Apple Containers is not available for one or more reasons.
    case unavailable([AppleContainersUnavailableReason])

    /// Whether Apple Containers is available and ready to use.
    public var isAvailable: Bool {
        if case .available = self { return true }
        return false
    }

    /// The reasons Apple Containers is unavailable, or an empty array when
    /// availability is `.available`.
    public var unavailableReasons: [AppleContainersUnavailableReason] {
        if case .unavailable(let reasons) = self { return reasons }
        return []
    }
}

/// Central gate for all Apple Containers entry points in the macOS app.
///
/// Resolution order:
/// 1. Feature flag (`apple_containers_enabled`) — if off, returns
///    `.unavailable([.featureFlagDisabled])` immediately without running
///    capability checks.
/// 2. OS version — Apple Containerization requires macOS 15 (Sequoia) or
///    later.
/// 3. Embedded runtime bundle — the `apple-containers-runtime` bundle must be
///    present inside `Bundle.main`.
/// 4. Runtime loader readiness — `AppleContainersRuntimeLoader.isReady` must
///    return `true` (added in PR 2).
///
/// All Apple Containers-specific surfaces (onboarding, settings, launcher,
/// restart) **must** consult this helper rather than performing ad hoc checks.
public enum AppleContainersAvailabilityChecker {

    // MARK: - Public API

    /// Evaluate and return Apple Containers availability for the current
    /// process, using the shared `MacOSClientFeatureFlagManager` and the live
    /// system environment.
    public static func evaluate() -> AppleContainersAvailability {
        return evaluate(
            flagManager: MacOSClientFeatureFlagManager.shared,
            osVersion: ProcessInfo.processInfo.operatingSystemVersion,
            bundleChecker: defaultBundleChecker,
            runtimeLoaderReady: defaultRuntimeLoaderReady
        )
    }

    // MARK: - Testable core

    /// Evaluate availability with injected dependencies.
    ///
    /// - Parameters:
    ///   - flagManager: The feature flag manager to consult.
    ///   - osVersion: The current operating system version.
    ///   - bundleChecker: Returns `true` if the embedded runtime bundle exists.
    ///   - runtimeLoaderReady: Returns `true` if the runtime loader reports
    ///     readiness.
    static func evaluate(
        flagManager: MacOSClientFeatureFlagManager,
        osVersion: OperatingSystemVersion,
        bundleChecker: () -> Bool,
        runtimeLoaderReady: () -> Bool
    ) -> AppleContainersAvailability {
        // 1. Feature flag gate — short-circuit if the flag is off.
        guard flagManager.isEnabled("apple_containers_enabled") else {
            log.debug("Apple Containers unavailable: feature flag disabled")
            return .unavailable([.featureFlagDisabled])
        }

        var reasons: [AppleContainersUnavailableReason] = []

        // 2. OS version check — requires macOS 15 (Sequoia) or later.
        if osVersion.majorVersion < 15 {
            log.debug("Apple Containers unavailable: OS version \(osVersion.majorVersion).\(osVersion.minorVersion) < 15.0")
            reasons.append(.osVersionTooLow)
        }

        // 3. Embedded runtime bundle check.
        if !bundleChecker() {
            log.debug("Apple Containers unavailable: runtime bundle not found in app bundle")
            reasons.append(.runtimeBundleNotFound)
        }

        // 4. Runtime loader readiness.
        if !runtimeLoaderReady() {
            log.debug("Apple Containers unavailable: runtime loader not ready")
            reasons.append(.runtimeLoaderNotReady)
        }

        if reasons.isEmpty {
            log.info("Apple Containers is available")
            return .available
        }

        log.debug("Apple Containers unavailable: \(reasons.map(\.description).joined(separator: ", "))")
        return .unavailable(reasons)
    }

    // MARK: - Default implementations

    /// Default bundle checker: looks for `apple-containers-runtime` inside
    /// `Bundle.main`. In PR 2, the runtime module is embedded here.
    private static let defaultBundleChecker: () -> Bool = {
        Bundle.main.url(forResource: "apple-containers-runtime", withExtension: "bundle") != nil
    }

    /// Default runtime loader readiness: always returns `false` until
    /// `AppleContainersRuntimeLoader` is introduced in PR 2. At that point
    /// this closure will be replaced with `AppleContainersRuntimeLoader.isReady`.
    private static let defaultRuntimeLoaderReady: () -> Bool = {
        false
    }
}
