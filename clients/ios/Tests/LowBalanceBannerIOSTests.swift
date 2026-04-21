#if canImport(UIKit)
import XCTest

@testable import VellumAssistantShared
@testable import vellum_assistant_ios

/// Unit tests for the LUM-1004 low-balance banner logic.
///
/// These cover the pure classification function and the web billing URL
/// resolver. The banner view itself is driven by SwiftUI state + an async
/// `BillingService` fetch and is tested manually against the simulator —
/// not worth stubbing a full HTTP round-trip for.
@MainActor
final class LowBalanceBannerIOSTests: XCTestCase {

    // MARK: - Fixtures

    /// Build a `BillingSummaryResponse` with a fixed effective balance; other
    /// fields are given plausible defaults. We only care about
    /// `effective_balance` for banner classification, but the struct has no
    /// memberwise init for callers outside the module, so we exercise the
    /// Codable path.
    private func makeSummary(effectiveBalance: String) throws -> BillingSummaryResponse {
        let json = """
        {
            "settled_balance": "\(effectiveBalance)",
            "pending_compute": "0.00",
            "effective_balance": "\(effectiveBalance)",
            "minimum_top_up": "5.00",
            "maximum_top_up": "1000.00",
            "maximum_balance": "1000.00",
            "allowed_top_up_amounts": ["5.00", "10.00", "25.00"],
            "is_degraded": false
        }
        """
        let data = Data(json.utf8)
        return try JSONDecoder().decode(BillingSummaryResponse.self, from: data)
    }

    // MARK: - state(for:) classification

    func testClassifiesZeroBalanceAsDepleted() throws {
        let summary = try makeSummary(effectiveBalance: "0.00")
        XCTAssertEqual(LowBalanceBanner.state(for: summary), .depleted)
    }

    func testClassifiesNegativeBalanceAsDepleted() throws {
        // The platform isn't expected to return a negative balance, but if it
        // ever does, depletion is the safe classification.
        let summary = try makeSummary(effectiveBalance: "-0.50")
        XCTAssertEqual(LowBalanceBanner.state(for: summary), .depleted)
    }

    func testClassifiesSubOneDollarAsLow() throws {
        let summary = try makeSummary(effectiveBalance: "0.75")
        XCTAssertEqual(LowBalanceBanner.state(for: summary), .low)
    }

    func testClassifiesThresholdBoundaryAsOk() throws {
        // Exactly $1.00 is the macOS boundary (strict `< 1.0`) — keep parity.
        let summary = try makeSummary(effectiveBalance: "1.00")
        XCTAssertEqual(LowBalanceBanner.state(for: summary), .ok)
    }

    func testClassifiesHealthyBalanceAsOk() throws {
        let summary = try makeSummary(effectiveBalance: "42.50")
        XCTAssertEqual(LowBalanceBanner.state(for: summary), .ok)
    }

    func testClassifiesUnparseableBalanceAsOk() throws {
        // A malformed server value should not produce a banner — silence is
        // better than a false alarm.
        let summary = try makeSummary(effectiveBalance: "not-a-number")
        XCTAssertEqual(LowBalanceBanner.state(for: summary), .ok)
    }

    // MARK: - webBillingURL resolver

    func testWebBillingURLUsesResolvedPlatformHost() {
        let url = LowBalanceBanner.webBillingURL
        XCTAssertEqual(url.path, "/billing")
        // The host should match the current platform URL (local / dev / prod).
        let expected = URL(string: VellumEnvironment.resolvedPlatformURL)
        XCTAssertEqual(url.host, expected?.host)
        XCTAssertEqual(url.scheme, expected?.scheme)
    }

    func testWebBillingURLIsAbsolute() {
        // SFSafariViewController requires an absolute http(s) URL — guard
        // against a future refactor accidentally producing a relative path.
        let url = LowBalanceBanner.webBillingURL
        XCTAssertNotNil(url.scheme)
        XCTAssertTrue(url.scheme == "http" || url.scheme == "https",
                      "Expected http/https scheme, got \(url.scheme ?? "nil")")
        XCTAssertNotNil(url.host)
    }
}
#endif
