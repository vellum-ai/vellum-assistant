import XCTest
@testable import VellumAssistantShared

/// Regression coverage for `AuthState`'s 4-case shape.
///
/// The enum distinguishes four authoritative states; the critical invariant
/// is that `.validationFailed` is NOT authenticated, but also NOT a
/// server-authoritative "logged out" — UI that offers a login button must
/// only do so for `.unauthenticated`, never for `.validationFailed`.
@MainActor
final class AuthStateTests: XCTestCase {
    private func makeUser() throws -> AllauthUser {
        let json = """
        {"id": "user-123", "email": "user@example.com", "display": "Example User"}
        """.data(using: .utf8)!
        return try JSONDecoder().decode(AllauthUser.self, from: json)
    }

    func testLoadingStateComputedProperties() {
        let manager = AuthManager()
        manager.state = .loading

        XCTAssertTrue(manager.isLoading)
        XCTAssertFalse(manager.isAuthenticated)
        XCTAssertFalse(manager.isValidationFailed)
        XCTAssertNil(manager.currentUser)
        XCTAssertNil(manager.lastValidationError)
    }

    func testUnauthenticatedStateComputedProperties() {
        let manager = AuthManager()
        manager.state = .unauthenticated

        XCTAssertFalse(manager.isLoading)
        XCTAssertFalse(manager.isAuthenticated)
        XCTAssertFalse(manager.isValidationFailed)
        XCTAssertNil(manager.currentUser)
        XCTAssertNil(manager.lastValidationError)
    }

    func testAuthenticatedStateComputedProperties() throws {
        let manager = AuthManager()
        let user = try makeUser()
        manager.state = .authenticated(user)

        XCTAssertFalse(manager.isLoading)
        XCTAssertTrue(manager.isAuthenticated)
        XCTAssertFalse(manager.isValidationFailed)
        XCTAssertEqual(manager.currentUser?.id, user.id)
        XCTAssertNil(manager.lastValidationError)
    }

    /// `.validationFailed` must report NOT authenticated (so gated APIs
    /// stay locked) but also NOT loading and NOT in a "logged out" state
    /// — distinct from `.unauthenticated` so UI can render a
    /// "reconnecting" affordance instead of a login button.
    func testValidationFailedStateComputedProperties() {
        let manager = AuthManager()
        let error = URLError(.notConnectedToInternet)
        manager.state = .validationFailed(lastError: error)

        XCTAssertFalse(manager.isLoading)
        XCTAssertFalse(manager.isAuthenticated)
        XCTAssertTrue(manager.isValidationFailed)
        XCTAssertNil(manager.currentUser)
        XCTAssertEqual((manager.lastValidationError as? URLError)?.code, .notConnectedToInternet)
    }

    /// Exhaustiveness guard: Swift's compile-time exhaustive-switch check
    /// ensures any future state added to `AuthState` must be handled
    /// explicitly at every switch site. This test asserts at runtime that
    /// the current set of cases maps 1:1 to the expected computed-property
    /// outputs, catching accidental collapse back to 3 cases.
    func testAllStatesHaveDistinctComputedProperties() throws {
        let manager = AuthManager()
        let user = try makeUser()

        manager.state = .loading
        let loadingFingerprint = [manager.isLoading, manager.isAuthenticated, manager.isValidationFailed]

        manager.state = .unauthenticated
        let unauthFingerprint = [manager.isLoading, manager.isAuthenticated, manager.isValidationFailed]

        manager.state = .authenticated(user)
        let authFingerprint = [manager.isLoading, manager.isAuthenticated, manager.isValidationFailed]

        manager.state = .validationFailed(lastError: URLError(.timedOut))
        let validationFailedFingerprint = [manager.isLoading, manager.isAuthenticated, manager.isValidationFailed]

        // All four states must have distinct boolean fingerprints.
        let fingerprints = [loadingFingerprint, unauthFingerprint, authFingerprint, validationFailedFingerprint]
        XCTAssertEqual(Set(fingerprints.map { $0.description }).count, 4)
    }
}
