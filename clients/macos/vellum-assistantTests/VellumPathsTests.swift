import XCTest
@testable import VellumAssistantShared

final class VellumPathsTests: XCTestCase {

    // Explicit test roots so we don't depend on process environment
    private let testHome = URL(fileURLWithPath: "/tmp/test-home")
    private let testXdgConfig = URL(fileURLWithPath: "/tmp/test-home/.config")
    private let testXdgData = URL(fileURLWithPath: "/tmp/test-home/.local/share")

    private func makePaths(_ env: VellumEnvironment) -> VellumPaths {
        VellumPaths(
            environment: env,
            homeDirectory: testHome,
            xdgConfigHome: testXdgConfig,
            xdgDataHome: testXdgData
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

    // MARK: - Parity: Swift matches TS production paths byte-for-byte

    func testProductionMatchesLegacyInlineConventions() {
        // These paths MUST match what LockfilePaths.swift, DeviceIdStore.swift,
        // SigningIdentityManager.swift, and FileCredentialStorage.swift
        // currently construct inline. PR 5 routes those callers through
        // VellumPaths.current and this parity must hold for production users
        // to see zero path changes.
        let paths = makePaths(.production)
        XCTAssertEqual(paths.lockfileCandidates[0].lastPathComponent, ".vellum.lock.json")
        XCTAssertEqual(paths.lockfileCandidates[1].lastPathComponent, ".vellum.lockfile.json")
        XCTAssertEqual(paths.deviceIdFile.path.hasSuffix("/.vellum/device.json"), true)
        XCTAssertEqual(paths.signingKeyFile.path.hasSuffix("/.vellum/protected/app-signing-key"), true)
        XCTAssertEqual(paths.credentialsDir.path.hasSuffix("/.vellum/protected/credentials"), true)
    }
}
