import XCTest
@testable import VellumAssistantLib

final class OnboardingManagedAuthStateTests: XCTestCase {
    func testPrimaryButtonTitleShowsSignInWhenUnauthenticated() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: false), "Sign in")
    }

    func testPrimaryButtonTitleShowsContinueLabelWhenAuthenticated() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: true), "Talk to your assistant")
    }

    func testContinuationActionStartsLoginWhenUnauthenticated() {
        XCTAssertEqual(
            onboardingManagedContinuationAction(isAuthenticated: false),
            .startLogin
        )
    }

    func testContinuationActionBootstrapsWhenAuthenticated() {
        XCTAssertEqual(onboardingManagedContinuationAction(isAuthenticated: true), .bootstrap)
    }
}
