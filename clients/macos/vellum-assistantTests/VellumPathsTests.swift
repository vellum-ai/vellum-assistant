import XCTest
@testable import VellumAssistantShared

/// Golden-value parity tests for `VellumPaths`. Asserts that each getter
/// returns the expected path string for each canonical environment. The
/// production expectations double as regression tests guaranteeing that
/// existing installs see byte-identical paths to the legacy inline code
/// they replace.
final class VellumPathsTests: XCTestCase {
    private let testHome = URL(fileURLWithPath: "/test/home")
    private let testXdgConfig = URL(fileURLWithPath: "/test/home/.config")

    private func paths(for env: VellumEnvironment) -> VellumPaths {
        VellumPaths(
            environment: env,
            homeDirectory: testHome,
            xdgConfigHome: testXdgConfig
        )
    }

    // MARK: - Production (legacy paths)

    func testProductionDeviceIdFile() {
        XCTAssertEqual(
            paths(for: .production).deviceIdFile.path,
            "/test/home/.vellum/device.json"
        )
    }

    func testProductionSigningKeyFile() {
        XCTAssertEqual(
            paths(for: .production).signingKeyFile.path,
            "/test/home/.vellum/protected/app-signing-key"
        )
    }

    func testProductionCredentialsDir() {
        XCTAssertEqual(
            paths(for: .production).credentialsDir.path,
            "/test/home/.vellum/protected/credentials"
        )
    }

    func testProductionPlatformTokenFile() {
        XCTAssertEqual(
            paths(for: .production).platformTokenFile.path,
            "/test/home/.config/vellum/platform-token"
        )
    }

    func testProductionLockfileCandidates() {
        XCTAssertEqual(
            paths(for: .production).lockfileCandidates.map(\.path),
            [
                "/test/home/.vellum.lock.json",
                "/test/home/.vellum.lockfile.json",
            ]
        )
    }

    // MARK: - Dev (non-prod, XDG-scoped)

    func testDevDeviceIdFile() {
        XCTAssertEqual(
            paths(for: .dev).deviceIdFile.path,
            "/test/home/.config/vellum-dev/device.json"
        )
    }

    func testDevSigningKeyFile() {
        XCTAssertEqual(
            paths(for: .dev).signingKeyFile.path,
            "/test/home/.config/vellum-dev/app-signing-key"
        )
    }

    func testDevCredentialsDir() {
        XCTAssertEqual(
            paths(for: .dev).credentialsDir.path,
            "/test/home/.config/vellum-dev/credentials"
        )
    }

    func testDevPlatformTokenFile() {
        XCTAssertEqual(
            paths(for: .dev).platformTokenFile.path,
            "/test/home/.config/vellum-dev/platform-token"
        )
    }

    func testDevLockfileCandidates() {
        XCTAssertEqual(
            paths(for: .dev).lockfileCandidates.map(\.path),
            ["/test/home/.config/vellum-dev/lockfile.json"]
        )
    }

    // MARK: - Staging (non-prod, XDG-scoped)

    func testStagingDeviceIdFile() {
        XCTAssertEqual(
            paths(for: .staging).deviceIdFile.path,
            "/test/home/.config/vellum-staging/device.json"
        )
    }

    func testStagingLockfileCandidates() {
        XCTAssertEqual(
            paths(for: .staging).lockfileCandidates.map(\.path),
            ["/test/home/.config/vellum-staging/lockfile.json"]
        )
    }

    // MARK: - Test (non-prod, XDG-scoped)

    func testTestEnvDeviceIdFile() {
        XCTAssertEqual(
            paths(for: .test).deviceIdFile.path,
            "/test/home/.config/vellum-test/device.json"
        )
    }

    func testTestEnvPlatformTokenFile() {
        XCTAssertEqual(
            paths(for: .test).platformTokenFile.path,
            "/test/home/.config/vellum-test/platform-token"
        )
    }

    // MARK: - Local (non-prod, XDG-scoped)

    func testLocalDeviceIdFile() {
        XCTAssertEqual(
            paths(for: .local).deviceIdFile.path,
            "/test/home/.config/vellum-local/device.json"
        )
    }

    func testLocalCredentialsDir() {
        XCTAssertEqual(
            paths(for: .local).credentialsDir.path,
            "/test/home/.config/vellum-local/credentials"
        )
    }

    func testLocalLockfileCandidates() {
        XCTAssertEqual(
            paths(for: .local).lockfileCandidates.map(\.path),
            ["/test/home/.config/vellum-local/lockfile.json"]
        )
    }

    // MARK: - Custom XDG_CONFIG_HOME

    func testCustomXdgConfigHomeDoesNotAffectProductionLegacyPaths() {
        let paths = VellumPaths(
            environment: .production,
            homeDirectory: testHome,
            xdgConfigHome: URL(fileURLWithPath: "/custom/xdg")
        )
        // Production's dotfile paths are home-rooted, not XDG-rooted, so a
        // custom XDG_CONFIG_HOME should not move them.
        XCTAssertEqual(paths.deviceIdFile.path, "/test/home/.vellum/device.json")
        XCTAssertEqual(
            paths.signingKeyFile.path,
            "/test/home/.vellum/protected/app-signing-key"
        )
        // ...but production's platform-token lives under XDG, so it *does*
        // follow the override.
        XCTAssertEqual(
            paths.platformTokenFile.path,
            "/custom/xdg/vellum/platform-token"
        )
    }

    func testCustomXdgConfigHomeAppliesToNonProduction() {
        let paths = VellumPaths(
            environment: .dev,
            homeDirectory: testHome,
            xdgConfigHome: URL(fileURLWithPath: "/custom/xdg")
        )
        XCTAssertEqual(
            paths.deviceIdFile.path,
            "/custom/xdg/vellum-dev/device.json"
        )
        XCTAssertEqual(
            paths.platformTokenFile.path,
            "/custom/xdg/vellum-dev/platform-token"
        )
    }

    // MARK: - Production parity with legacy inline code

    /// Documents that the production paths VellumPaths returns match exactly
    /// the paths the pre-Phase-1 inline code constructed. These strings are
    /// the load-bearing contract with the daemon, CLI, CES, and chrome
    /// extension native host — any change here would break cross-process
    /// coordination for existing installs.
    func testProductionPathsMatchLegacyInlineConventions() {
        let p = paths(for: .production)
        // LockfilePaths.swift legacy: `~/.vellum.lock.json` + legacy fallback
        XCTAssertEqual(p.lockfileCandidates[0].path, "/test/home/.vellum.lock.json")
        XCTAssertEqual(p.lockfileCandidates[1].path, "/test/home/.vellum.lockfile.json")
        // DeviceIdStore.swift legacy: `~/.vellum/device.json`
        XCTAssertEqual(p.deviceIdFile.path, "/test/home/.vellum/device.json")
        // SigningIdentityManager.swift legacy: `~/.vellum/protected/app-signing-key`
        XCTAssertEqual(p.signingKeyFile.path, "/test/home/.vellum/protected/app-signing-key")
        // FileCredentialStorage.swift legacy: `~/.vellum/protected/credentials`
        XCTAssertEqual(p.credentialsDir.path, "/test/home/.vellum/protected/credentials")
    }
}
