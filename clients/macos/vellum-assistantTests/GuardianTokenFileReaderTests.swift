import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for the bootstrap-window amplifier fix: an expired access token must
/// not cause the whole credential file to be thrown away when the refresh
/// token is still valid. Exercises the pure `decideImport` function so no
/// keychain side effects leak into the tests.
final class GuardianTokenFileReaderTests: XCTestCase {

    private var tmpDir: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("guardian-token-reader-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        tmpDir = nil
        super.tearDown()
    }

    // MARK: - Fixture helpers

    /// Writes a guardian-token.json fixture to `tmpDir` and returns its path.
    /// `accessExpiresMs` and `refreshExpiresMs` are absolute epoch-ms so tests
    /// can construct the exact expiry relationship they want to verify.
    private func writeFixture(
        accessExpiresMs: Int,
        refreshExpiresMs: Int,
        refreshAfterMs: Int? = nil
    ) -> String {
        let path = tmpDir.appendingPathComponent("guardian-token.json").path
        let body: [String: Any] = [
            "guardianPrincipalId": "vellum-principal-test",
            "accessToken": "header.payload.signature",
            "accessTokenExpiresAt": accessExpiresMs,
            "refreshToken": "refresh-test-token",
            "refreshTokenExpiresAt": refreshExpiresMs,
            "refreshAfter": refreshAfterMs ?? (accessExpiresMs - 60_000),
            "isNew": false,
            "deviceId": "test-device-id",
            "leasedAt": "2026-04-19T00:00:00Z"
        ]
        let data = try! JSONSerialization.data(withJSONObject: body, options: [])
        try! data.write(to: URL(fileURLWithPath: path))
        return path
    }

    // MARK: - decideImport

    func testImportsWhenBothTokensValid() {
        let nowMs = 1_000_000_000
        let path = writeFixture(
            accessExpiresMs: nowMs + 30 * 60_000, // +30 min
            refreshExpiresMs: nowMs + 90 * 24 * 60 * 60_000 // +90 days
        )
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: nowMs)
        if case .importValid(let creds) = decision {
            XCTAssertEqual(creds.accessToken, "header.payload.signature")
            XCTAssertEqual(creds.refreshToken, "refresh-test-token")
        } else {
            XCTFail("Expected .importValid, got \(decision)")
        }
    }

    /// The core amplifier fix: an expired access token with a still-valid
    /// refresh token must import the credentials, not throw them away. The 401
    /// retry interceptor will rotate the refresh token on the next request.
    func testImportsWhenAccessExpiredButRefreshStillValid() {
        let nowMs = 1_000_000_000
        let path = writeFixture(
            accessExpiresMs: nowMs - 10 * 60_000, // expired 10 min ago
            refreshExpiresMs: nowMs + 60 * 24 * 60 * 60_000 // +60 days (still valid)
        )
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: nowMs)
        if case .importAccessExpired(let creds) = decision {
            XCTAssertEqual(creds.refreshToken, "refresh-test-token",
                           "Refresh token must be preserved for the 401 interceptor to rotate")
            XCTAssertLessThan(creds.accessExpiresEpoch, nowMs,
                              "Access expiry should be in the past as set up")
            XCTAssertGreaterThan(creds.refreshExpiresEpoch, nowMs,
                                 "Refresh expiry should be in the future as set up")
        } else {
            XCTFail("Expected .importAccessExpired (so the refresh token survives), got \(decision)")
        }
    }

    func testSkipsWhenRefreshTokenExpired() {
        let nowMs = 1_000_000_000
        let path = writeFixture(
            accessExpiresMs: nowMs - 10 * 60_000,
            refreshExpiresMs: nowMs - 1 // expired
        )
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: nowMs)
        XCTAssertEqual(decision, .skipRefreshExpired)
    }

    func testBoundaryNowEqualToAccessExpiryTreatedAsExpired() {
        // The guard is `nowMs >= accessExpiresEpoch`, so equality = expired.
        let nowMs = 1_000_000_000
        let path = writeFixture(
            accessExpiresMs: nowMs,
            refreshExpiresMs: nowMs + 60_000
        )
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: nowMs)
        if case .importAccessExpired = decision {
            // Expected — equality counts as expired, refresh still valid.
        } else {
            XCTFail("Equality-at-expiry should route through .importAccessExpired, got \(decision)")
        }
    }

    func testBoundaryNowEqualToRefreshExpirySkipsImport() {
        // Equality on the refresh expiry also counts as expired → skip.
        let nowMs = 1_000_000_000
        let path = writeFixture(
            accessExpiresMs: nowMs - 60_000,
            refreshExpiresMs: nowMs
        )
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: nowMs)
        XCTAssertEqual(decision, .skipRefreshExpired)
    }

    func testSkipsWhenFileMissing() {
        let path = tmpDir.appendingPathComponent("does-not-exist.json").path
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: 1_000_000_000)
        XCTAssertEqual(decision, .skipMissingFile)
    }

    func testSkipsWhenJsonUnparseable() {
        let path = tmpDir.appendingPathComponent("guardian-token.json").path
        try! "not-json".data(using: .utf8)!.write(to: URL(fileURLWithPath: path))
        let decision = GuardianTokenFileReader.decideImport(fromPath: path, nowMs: 1_000_000_000)
        XCTAssertEqual(decision, .skipUnparseableJson)
    }
}
