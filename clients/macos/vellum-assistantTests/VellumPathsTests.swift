import XCTest
@testable import VellumAssistantShared

final class VellumPathsTests: XCTestCase {

    // Explicit test roots so we don't depend on process environment
    private let testHome = URL(fileURLWithPath: "/tmp/test-home")
    private let testXdgConfig = URL(fileURLWithPath: "/tmp/test-home/.config")

    private func makePaths(_ env: VellumEnvironment) -> VellumPaths {
        VellumPaths(
            environment: env,
            homeDirectory: testHome,
            xdgConfigHome: testXdgConfig
        )
    }

    // MARK: - Production: legacy paths preserved byte-for-byte

    func testProductionLockfileCandidates() {
        let paths = makePaths(.production)
        XCTAssertEqual(
            paths.lockfileCandidates.map(\.path),
            [
                "/tmp/test-home/.vellum.lock.json",
                "/tmp/test-home/.vellum.lockfile.json",
            ]
        )
    }

    func testProductionDeviceIdFile() {
        XCTAssertEqual(
            makePaths(.production).deviceIdFile.path,
            "/tmp/test-home/.vellum/device.json"
        )
    }

    func testProductionSigningKeyFile() {
        XCTAssertEqual(
            makePaths(.production).signingKeyFile.path,
            "/tmp/test-home/.vellum/protected/app-signing-key"
        )
    }

    func testProductionCredentialsDir() {
        XCTAssertEqual(
            makePaths(.production).credentialsDir.path,
            "/tmp/test-home/.vellum/protected/credentials"
        )
    }

    func testProductionConfigDir() {
        XCTAssertEqual(
            makePaths(.production).configDir.path,
            "/tmp/test-home/.config/vellum"
        )
    }

    func testProductionPlatformTokenFile() {
        XCTAssertEqual(
            makePaths(.production).platformTokenFile.path,
            "/tmp/test-home/.config/vellum/platform-token"
        )
    }

    // MARK: - Non-production: env-scoped paths

    func testDevLockfileCandidates() {
        XCTAssertEqual(
            makePaths(.dev).lockfileCandidates.map(\.path),
            ["/tmp/test-home/.config/vellum-dev/lockfile.json"]
        )
    }

    func testDevDeviceIdFile() {
        XCTAssertEqual(
            makePaths(.dev).deviceIdFile.path,
            "/tmp/test-home/.config/vellum-dev/device.json"
        )
    }

    func testDevSigningKeyFile() {
        XCTAssertEqual(
            makePaths(.dev).signingKeyFile.path,
            "/tmp/test-home/.config/vellum-dev/app-signing-key"
        )
    }

    func testDevCredentialsDir() {
        XCTAssertEqual(
            makePaths(.dev).credentialsDir.path,
            "/tmp/test-home/.config/vellum-dev/credentials"
        )
    }

    func testDevConfigDir() {
        XCTAssertEqual(
            makePaths(.dev).configDir.path,
            "/tmp/test-home/.config/vellum-dev"
        )
    }

    func testStagingConfigDir() {
        XCTAssertEqual(
            makePaths(.staging).configDir.path,
            "/tmp/test-home/.config/vellum-staging"
        )
    }

    func testTestConfigDir() {
        XCTAssertEqual(
            makePaths(.test).configDir.path,
            "/tmp/test-home/.config/vellum-test"
        )
    }

    func testLocalConfigDir() {
        XCTAssertEqual(
            makePaths(.local).configDir.path,
            "/tmp/test-home/.config/vellum-local"
        )
    }

    // MARK: - Parity: Swift matches pre-refactor inline paths byte-for-byte

    /// Backwards-compat anchor for PR 5. Every getter below MUST produce a path
    /// byte-identical to the inline construction each consumer used before PR 5
    /// routed them through `VellumPaths.current`. If any of these assertions
    /// change, production users will see a path shift — audit the consumer list
    /// (`LockfilePaths`, `DeviceIdStore`, `SigningIdentityManager`,
    /// `FileCredentialStorage`, `SessionTokenManager.xdgPlatformTokenPath`,
    /// `GuardianTokenFileReader`) and ship a migration.
    func testProductionMatchesLegacyInlineConventions() {
        let paths = makePaths(.production)

        XCTAssertEqual(
            paths.lockfileCandidates[0].path,
            "/tmp/test-home/.vellum.lock.json"
        )
        XCTAssertEqual(
            paths.lockfileCandidates[1].path,
            "/tmp/test-home/.vellum.lockfile.json"
        )
        XCTAssertEqual(
            paths.deviceIdFile.path,
            "/tmp/test-home/.vellum/device.json"
        )
        XCTAssertEqual(
            paths.signingKeyFile.path,
            "/tmp/test-home/.vellum/protected/app-signing-key"
        )
        XCTAssertEqual(
            paths.credentialsDir.path,
            "/tmp/test-home/.vellum/protected/credentials"
        )
        XCTAssertEqual(
            paths.platformTokenFile.path,
            "/tmp/test-home/.config/vellum/platform-token"
        )
    }

    // MARK: - resolveXdgConfigHome

    // These tests mutate the process environment and must restore it in
    // `defer` blocks so they don't leak into neighbouring tests.

    func testResolveXdgConfigHomeAbsolute() {
        let previous = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
        setenv("XDG_CONFIG_HOME", "/custom/xdg", 1)
        defer {
            if let previous {
                setenv("XDG_CONFIG_HOME", previous, 1)
            } else {
                unsetenv("XDG_CONFIG_HOME")
            }
        }

        XCTAssertEqual(VellumPaths.resolveXdgConfigHome().path, "/custom/xdg")
    }

    func testResolveXdgConfigHomeRelativeIsAccepted() {
        // Parity with cli/src/lib/environments/paths.ts:xdgConfigHome() and
        // assistant/src/util/platform.ts:getXdgPlatformTokenPath, both of
        // which accept the raw env var without an absolute-path guard.
        let previous = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
        setenv("XDG_CONFIG_HOME", "relative/xdg", 1)
        defer {
            if let previous {
                setenv("XDG_CONFIG_HOME", previous, 1)
            } else {
                unsetenv("XDG_CONFIG_HOME")
            }
        }

        // `URL(fileURLWithPath:)` resolves a relative path against the
        // current working directory — the key assertion is that we did NOT
        // silently fall back to NSHomeDirectory()/.config.
        let resolved = VellumPaths.resolveXdgConfigHome()
        let fallback = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".config").path
        XCTAssertNotEqual(resolved.path, fallback)
        XCTAssertTrue(
            resolved.path.hasSuffix("/relative/xdg"),
            "expected relative path to be preserved, got \(resolved.path)"
        )
    }

    func testResolveXdgConfigHomeUnsetFallsBackToHomeConfig() {
        // Production path: env var unset → NSHomeDirectory()/.config. This
        // is the byte-identical production case that must stay intact.
        let previous = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
        unsetenv("XDG_CONFIG_HOME")
        defer {
            if let previous {
                setenv("XDG_CONFIG_HOME", previous, 1)
            }
        }

        let expected = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".config").path
        XCTAssertEqual(VellumPaths.resolveXdgConfigHome().path, expected)
    }

    func testResolveXdgConfigHomeWhitespaceFallsBackToHomeConfig() {
        let previous = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
        setenv("XDG_CONFIG_HOME", "   ", 1)
        defer {
            if let previous {
                setenv("XDG_CONFIG_HOME", previous, 1)
            } else {
                unsetenv("XDG_CONFIG_HOME")
            }
        }

        let expected = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".config").path
        XCTAssertEqual(VellumPaths.resolveXdgConfigHome().path, expected)
    }
}
