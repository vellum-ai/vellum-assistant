import XCTest
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for the attributed subtitle on `SettingsBillingTab`'s Add Credits card.
///
/// Verifies:
/// - The subtitle is `nil` while the billing summary is still loading.
/// - When a summary is present, the subtitle ends with a tappable
///   "Learn more about pricing" link pointing at `AppURLs.pricingDocs`.
/// - The link target honors the `VELLUM_DOCS_BASE_URL` env var override so the
///   docs base URL stays a single source of truth.
@MainActor
final class SettingsBillingTabSubtitleTests: XCTestCase {
    private var originalEnvValue: String?

    override func setUp() {
        super.setUp()
        originalEnvValue = ProcessInfo.processInfo.environment["VELLUM_DOCS_BASE_URL"]
        unsetenv("VELLUM_DOCS_BASE_URL")
    }

    override func tearDown() {
        if let value = originalEnvValue {
            setenv("VELLUM_DOCS_BASE_URL", value, 1)
        } else {
            unsetenv("VELLUM_DOCS_BASE_URL")
        }
        super.tearDown()
    }

    // MARK: - Tests

    func testSubtitleNilWhenSummaryNotLoaded() {
        let view = SettingsBillingTab(authManager: AuthManager(), initialSummary: nil)
        XCTAssertNil(view.addCreditsSubtitleAttributed)
    }

    func testSubtitleContainsPricingLink() {
        let summary = makeSummary(maximumBalance: "1000")
        let view = SettingsBillingTab(authManager: AuthManager(), initialSummary: summary)

        let attributed = view.addCreditsSubtitleAttributed
        XCTAssertNotNil(attributed)

        let plain = String(attributed!.characters)
        XCTAssertTrue(plain.contains("Learn more about pricing"))
        XCTAssertTrue(plain.contains("Credits cost $1 each"))
        XCTAssertTrue(plain.contains("maximum balance of 1,000"))

        let linkRuns = attributed!.runs.filter { $0.link != nil }
        XCTAssertEqual(linkRuns.count, 1, "Subtitle should contain exactly one link")
        XCTAssertEqual(
            linkRuns.first?.link?.absoluteString,
            AppURLs.pricingDocs.absoluteString
        )
    }

    func testSubtitleHonorsDocsBaseURLOverride() {
        setenv("VELLUM_DOCS_BASE_URL", "https://staging.vellum.ai/docs", 1)
        defer { unsetenv("VELLUM_DOCS_BASE_URL") }

        let summary = makeSummary(maximumBalance: "1000")
        let view = SettingsBillingTab(authManager: AuthManager(), initialSummary: summary)

        let attributed = view.addCreditsSubtitleAttributed
        let linkRun = attributed?.runs.first { $0.link != nil }
        XCTAssertEqual(
            linkRun?.link?.absoluteString,
            "https://staging.vellum.ai/docs/pricing"
        )
    }

    // MARK: - Fixture

    /// Builds a `BillingSummaryResponse` with sensible defaults, parameterized
    /// only on the fields the subtitle tests care about.
    private func makeSummary(maximumBalance: String) -> BillingSummaryResponse {
        BillingSummaryResponse(
            settled_balance: "100.00",
            pending_compute: "0.00",
            effective_balance: "100.00",
            minimum_top_up: "10.00",
            maximum_top_up: "100.00",
            maximum_balance: maximumBalance,
            allowed_top_up_amounts: ["10.00", "25.00", "50.00"],
            is_degraded: false
        )
    }
}
