import XCTest
@testable import VellumAssistantShared

/// Pure-Swift decode tests for `PrivacyConfig` — validates the JSON schema
/// contract with the gateway's `{assistantId}/config/privacy` endpoint and the
/// struct's `Equatable` conformance. No network mocking required.
final class FeatureFlagClientPrivacyTests: XCTestCase {

    // MARK: - Decode

    /// Decodes a representative payload with a 1-day retention window.
    func testPrivacyConfigDecodesFromRepresentativeJSON() throws {
        // GIVEN a JSON payload matching the gateway response shape
        let json = """
        {
            "collectUsageData": true,
            "sendDiagnostics": false,
            "llmRequestLogRetentionMs": 86400000
        }
        """.data(using: .utf8)!

        // WHEN we decode it into a PrivacyConfig
        let config = try JSONDecoder().decode(PrivacyConfig.self, from: json)

        // THEN each field matches the payload
        XCTAssertTrue(config.collectUsageData)
        XCTAssertFalse(config.sendDiagnostics)
        XCTAssertEqual(config.llmRequestLogRetentionMs, 86_400_000)
    }

    /// A retention value of 0 (meaning "prune immediately") must round-trip
    /// through the decoder unchanged. This guards against accidental
    /// truthy-coercion regressions if someone swaps `Int64?` for a Boolean-ish type.
    func testPrivacyConfigDecodesZeroRetention() throws {
        // GIVEN a payload with llmRequestLogRetentionMs = 0
        let json = """
        {
            "collectUsageData": false,
            "sendDiagnostics": true,
            "llmRequestLogRetentionMs": 0
        }
        """.data(using: .utf8)!

        // WHEN we decode it
        let config = try JSONDecoder().decode(PrivacyConfig.self, from: json)

        // THEN retention is exactly 0
        XCTAssertFalse(config.collectUsageData)
        XCTAssertTrue(config.sendDiagnostics)
        XCTAssertEqual(config.llmRequestLogRetentionMs, 0)
    }

    /// A retention value of null (meaning "keep forever") must decode to nil.
    func testPrivacyConfigDecodesNullRetention() throws {
        // GIVEN a payload with llmRequestLogRetentionMs = null
        let json = """
        {
            "collectUsageData": true,
            "sendDiagnostics": true,
            "llmRequestLogRetentionMs": null
        }
        """.data(using: .utf8)!

        // WHEN we decode it
        let config = try JSONDecoder().decode(PrivacyConfig.self, from: json)

        // THEN retention is nil (keep forever)
        XCTAssertTrue(config.collectUsageData)
        XCTAssertTrue(config.sendDiagnostics)
        XCTAssertNil(config.llmRequestLogRetentionMs)
    }

    // MARK: - Equatable

    /// Two configs constructed with the same fields must compare equal.
    func testPrivacyConfigEquatableSameFields() {
        // GIVEN two identically-constructed configs
        let a = PrivacyConfig(
            collectUsageData: true,
            sendDiagnostics: false,
            llmRequestLogRetentionMs: 86_400_000
        )
        let b = PrivacyConfig(
            collectUsageData: true,
            sendDiagnostics: false,
            llmRequestLogRetentionMs: 86_400_000
        )

        // THEN they are equal
        XCTAssertEqual(a, b)
    }

    /// Two configs that differ only in retention must NOT compare equal —
    /// critical because the UI picker diffs against the current value to
    /// decide whether to send a PATCH.
    func testPrivacyConfigEquatableDifferentRetention() {
        // GIVEN two configs that differ only in retention
        let a = PrivacyConfig(
            collectUsageData: true,
            sendDiagnostics: false,
            llmRequestLogRetentionMs: 86_400_000
        )
        let b = PrivacyConfig(
            collectUsageData: true,
            sendDiagnostics: false,
            llmRequestLogRetentionMs: 604_800_000
        )

        // THEN they are not equal
        XCTAssertNotEqual(a, b)
    }
}
