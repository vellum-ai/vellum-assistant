import XCTest
@testable import VellumAssistantLib

/// Last-mile defense against raw `sourceEventName` strings leaking into the
/// notification UI. Server-side checks (deterministic-checks
/// `checkRenderedCopyQuality`) suppress these at emit time; these tests cover
/// the client-side guard that runs even if a bad payload slips past the
/// server.
final class NotificationCopySanitizationTests: XCTestCase {

    // MARK: - sanitizeNotificationTitle

    func testTitlePassthroughForRealCopy() {
        let result = AppDelegate.sanitizeNotificationTitle(
            "New email from Alice",
            sourceEventName: "email.received"
        )
        XCTAssertEqual(result, "New email from Alice")
    }

    func testTitleEmptyStringFallsBackToPlaceholder() {
        let result = AppDelegate.sanitizeNotificationTitle(
            "",
            sourceEventName: "email.received"
        )
        XCTAssertEqual(result, "Notification")
    }

    func testTitleWhitespaceOnlyFallsBackToPlaceholder() {
        let result = AppDelegate.sanitizeNotificationTitle(
            "   \n  ",
            sourceEventName: "email.received"
        )
        XCTAssertEqual(result, "Notification")
    }

    func testTitleRawEventNameFallsBackToPlaceholder() {
        let result = AppDelegate.sanitizeNotificationTitle(
            "user.send_notification",
            sourceEventName: "user.send_notification"
        )
        XCTAssertEqual(result, "Notification")
    }

    func testTitleHumanizedTemplateTitleIsNotFlagged() {
        // copy-composer templates produce legitimate humanized titles like
        // "Guardian Question" for `guardian.question` and "Activity Complete"
        // for `activity.complete`. These must pass through unchanged — they
        // are intentional copy, not raw event-name leaks.
        XCTAssertEqual(
            AppDelegate.sanitizeNotificationTitle(
                "Guardian Question",
                sourceEventName: "guardian.question"
            ),
            "Guardian Question"
        )
        XCTAssertEqual(
            AppDelegate.sanitizeNotificationTitle(
                "Activity Complete",
                sourceEventName: "activity.complete"
            ),
            "Activity Complete"
        )
    }

    func testTitleCaseInsensitiveEventNameLeakIsCaught() {
        let result = AppDelegate.sanitizeNotificationTitle(
            "USER.SEND_NOTIFICATION",
            sourceEventName: "user.send_notification"
        )
        XCTAssertEqual(result, "Notification")
    }

    // MARK: - sanitizeNotificationBody

    func testBodyPassthroughForRealCopy() {
        let result = AppDelegate.sanitizeNotificationBody(
            "Alice replied to your message.",
            sourceEventName: "email.received"
        )
        XCTAssertEqual(result, "Alice replied to your message.")
    }

    func testBodyEmptyStringFallsBackToPlaceholder() {
        let result = AppDelegate.sanitizeNotificationBody(
            "",
            sourceEventName: "email.received"
        )
        XCTAssertEqual(result, "(no preview available)")
    }

    func testBodyRawEventNameFallsBackToPlaceholder() {
        let result = AppDelegate.sanitizeNotificationBody(
            "user.send_notification",
            sourceEventName: "user.send_notification"
        )
        XCTAssertEqual(result, "(no preview available)")
    }

    func testBodyHumanizedFormIsNotFlagged() {
        // Humanized space-separated variants of the event name are legitimate
        // copy (e.g. template-derived body text). They must not be replaced
        // with the generic placeholder.
        let result = AppDelegate.sanitizeNotificationBody(
            "user send notification",
            sourceEventName: "user.send_notification"
        )
        XCTAssertEqual(result, "user send notification")
    }

    // MARK: - isEventNameLeak edge cases

    func testEmptyCandidateIsNotLeak() {
        XCTAssertFalse(AppDelegate.isEventNameLeak("", sourceEventName: "user.send_notification"))
    }

    func testEmptySourceEventNameIsNeverLeak() {
        XCTAssertFalse(AppDelegate.isEventNameLeak("Notification", sourceEventName: ""))
    }

    func testPartialMatchIsNotLeak() {
        // We only flag exact matches (raw or normalized). A title that merely
        // contains the event name is allowed through — it's a real composed
        // string, not a fallback leak.
        XCTAssertFalse(AppDelegate.isEventNameLeak(
            "Got a user.send_notification event",
            sourceEventName: "user.send_notification"
        ))
    }
}
