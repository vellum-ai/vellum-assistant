import XCTest
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

/// Tests for the `account-deletion` feature-flag-gated Danger Zone section in
/// `SettingsGeneralTab`, and for the `DeleteAccountConfirmView` confirmation
/// modal. The modal calls `AuthService.requestAccountDeletion()`, which posts
/// directly to platform at `/v1/user/deletion-request/` and returns
/// `.requested` (HTTP 201) when the server-side `account-deletion` flag is on
/// or `.unavailable` (HTTP 404) when off.
@MainActor
final class DeleteAccountTests: XCTestCase {

    // MARK: - Section visibility (flag- and auth-gated)

    /// The Danger Zone is hidden when the client-side `account-deletion` flag
    /// is off (the registry default).
    func testDangerZoneHiddenWhenFlagOff() {
        let manager = MacOSClientFeatureFlagManager(environment: [:])
        XCTAssertFalse(SettingsGeneralTab.shouldShowDangerZone(
            flagManager: manager,
            isAuthenticated: true
        ))
    }

    /// The Danger Zone is visible when the client-side `account-deletion` flag
    /// is on (e.g. via a `VELLUM_FLAG_ACCOUNT_DELETION=1` override) and the
    /// session is authenticated.
    func testDangerZoneVisibleWhenFlagOnAndAuthenticated() {
        let manager = MacOSClientFeatureFlagManager(
            environment: ["VELLUM_FLAG_ACCOUNT_DELETION": "1"]
        )
        XCTAssertTrue(SettingsGeneralTab.shouldShowDangerZone(
            flagManager: manager,
            isAuthenticated: true
        ))
    }

    /// The Danger Zone stays hidden when the user isn't signed in, even with
    /// the flag enabled — the POST would fail with `notAuthenticated` so the
    /// destructive button shouldn't be offered in the first place.
    func testDangerZoneHiddenWhenUnauthenticatedEvenWithFlagOn() {
        let manager = MacOSClientFeatureFlagManager(
            environment: ["VELLUM_FLAG_ACCOUNT_DELETION": "1"]
        )
        XCTAssertFalse(SettingsGeneralTab.shouldShowDangerZone(
            flagManager: manager,
            isAuthenticated: false
        ))
    }

    /// Other client flags do not flip the gate — only the literal
    /// `account-deletion` key controls visibility.
    func testDangerZoneHiddenForUnrelatedFlag() {
        let manager = MacOSClientFeatureFlagManager(
            environment: ["VELLUM_FLAG_MOBILE_PAIRING": "1"]
        )
        XCTAssertFalse(SettingsGeneralTab.shouldShowDangerZone(
            flagManager: manager,
            isAuthenticated: true
        ))
    }

    // MARK: - DeleteAccountConfirmView submit behavior

    /// On a `.requested` result, the modal reports `.deleted` to the parent so
    /// the parent can dismiss the sheet and run the standard logout sequence.
    func testConfirmModalReportsDeletedOnRequested() async {
        var capturedOutcome: DeleteAccountConfirmView.Outcome?

        let view = DeleteAccountConfirmView(
            onDeleted: { outcome in capturedOutcome = outcome },
            onCancel: { XCTFail("Cancel should not fire on success") },
            requestAccountDeletion: { .requested }
        )

        let error = await view.submit()
        XCTAssertNil(error, "Successful request should not surface an error")
        if case .deleted = capturedOutcome {
            // expected
        } else {
            XCTFail("Expected .deleted outcome, got \(String(describing: capturedOutcome))")
        }
    }

    /// On an `.unavailable` result (server-side flag off), the modal surfaces
    /// an inline error and does not report `.deleted` to the parent.
    func testConfirmModalShowsErrorOnUnavailable() async {
        let view = DeleteAccountConfirmView(
            onDeleted: { _ in XCTFail("onDeleted should not fire on unavailable") },
            onCancel: { XCTFail("Cancel should not fire on submit failure") },
            requestAccountDeletion: { .unavailable }
        )

        let error = await view.submit()
        XCTAssertNotNil(error, "Unavailable should surface an error message")
        XCTAssertTrue(error?.contains("not available") ?? false,
                      "Expected unavailable copy, got: \(error ?? "<nil>")")
    }

    /// When the underlying request throws, the modal surfaces an inline error
    /// with the localized description.
    func testConfirmModalShowsErrorOnNetworkFailure() async {
        struct StubError: LocalizedError {
            var errorDescription: String? { "stub network failure" }
        }

        let view = DeleteAccountConfirmView(
            onDeleted: { _ in XCTFail("onDeleted should not fire on throw") },
            onCancel: { XCTFail("Cancel should not fire on submit failure") },
            requestAccountDeletion: { throw StubError() }
        )

        let error = await view.submit()
        XCTAssertNotNil(error)
        XCTAssertTrue(error?.contains("stub network failure") ?? false,
                      "Expected stub error to be surfaced, got: \(error ?? "<nil>")")
    }

    /// Verifies that the modal's submit path actually drives the injected
    /// closure exactly once — i.e. the production default closure is the
    /// integration point the view exercises on confirm.
    func testConfirmModalDrivesRequestExactlyOnce() async {
        var callCount = 0
        let view = DeleteAccountConfirmView(
            onDeleted: { _ in },
            onCancel: { },
            requestAccountDeletion: {
                callCount += 1
                return .requested
            }
        )

        _ = await view.submit()
        XCTAssertEqual(callCount, 1, "Expected exactly one request per submit()")
    }
}
