import XCTest
@testable import VellumAssistantLib

final class OnboardingManagedAuthStateTests: XCTestCase {
    func testPrimaryButtonTitleShowsSignInWhenUnauthenticated() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: false), "Sign in")
    }

    func testPrimaryButtonTitleShowsContinueLabelWhenAuthenticatedWithAssistant() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: true, hasAssistant: true), "Talk to your assistant")
    }

    func testPrimaryButtonTitleShowsHatchLabelWhenAuthenticatedWithoutAssistant() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: true, hasAssistant: false), "Hatch your assistant")
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
