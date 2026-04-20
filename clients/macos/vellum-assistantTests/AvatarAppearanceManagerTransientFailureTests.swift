import XCTest
@testable import VellumAssistantLib

/// Tests for the bootstrap-window amplifier fix in avatar fetches: transient
/// failures (401 during auth race, 5xx backend hiccup, transport/network
/// error) must not clear cached state. Only an authoritative 404 from the
/// daemon counts as "no avatar exists" and clears cached state.
@MainActor
final class AvatarAppearanceManagerTransientFailureTests: XCTestCase {

    // MARK: - isAuthoritativeAbsence

    func test404CountsAsAuthoritativeAbsence() {
        XCTAssertTrue(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 404))
    }

    func test401DoesNotCountAsAuthoritativeAbsence() {
        // 401 during the bootstrap auth race is the exact scenario the fix
        // addresses — an expired/missing token triggers the retry interceptor,
        // and we must not wipe the cached avatar while that's happening.
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 401))
    }

    func test403DoesNotCountAsAuthoritativeAbsence() {
        // 403 can mean the gateway is still locking out new tokens after a
        // re-bootstrap; same preserve-and-retry policy as 401.
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 403))
    }

    func test5xxDoesNotCountAsAuthoritativeAbsence() {
        for status in [500, 502, 503, 504] {
            XCTAssertFalse(
                AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: status),
                "HTTP \(status) is a backend hiccup, not an authoritative absence"
            )
        }
    }

    func test2xxNotTreatedAsAbsence() {
        // 2xx means the caller should not reach the absence check at all,
        // but defensively verify.
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 200))
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 204))
    }

    func testOnlyExactly404CountsAsAbsence() {
        // No accidental broader match — e.g. 4xx as a class is NOT absence,
        // only the specific 404 "file not found" signal.
        for status in [400, 402, 405, 410, 429] {
            XCTAssertFalse(
                AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: status),
                "Only 404 should be treated as authoritative absence; HTTP \(status) is not"
            )
        }
    }
}
