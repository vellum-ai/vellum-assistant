import XCTest
@testable import VellumAssistantLib

final class OnboardingManagedAuthStateTests: XCTestCase {
    func testPrimaryButtonTitleShowsSignInWhenUnauthenticatedAndManagedEnabled() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: false, managedSignInEnabled: true), "Sign in")
    }

    func testPrimaryButtonTitleShowsComingSoonWhenUnauthenticatedAndManagedDisabled() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: false, managedSignInEnabled: false), "Coming Soon")
    }

    func testPrimaryButtonTitleShowsContinueLabelWhenAuthenticated() {
        XCTAssertEqual(onboardingPrimaryButtonTitle(isAuthenticated: true, managedSignInEnabled: true), "Talk to your assistant")
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
