import XCTest
@testable import VellumAssistantLib

@MainActor
final class MainWindowAvatarRoutingTests: XCTestCase {

    func testCustomizeAvatarTransitionsFromIdentityToAvatarPanel() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.identity)

        // Simulate what onCustomizeAvatar closure does
        state.selection = .panel(.avatarCustomization)

        XCTAssertEqual(state.selection, .panel(.avatarCustomization))
    }

    func testAvatarCustomizationPanelIsValidSelection() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.avatarCustomization)

        if case .panel(let panel) = state.selection {
            XCTAssertEqual(panel, .avatarCustomization)
        } else {
            XCTFail("Expected .panel(.avatarCustomization)")
        }
    }

    func testIdentityPanelIsValidSelection() {
        let state = MainWindowState(hasAPIKey: false)
        state.selection = .panel(.identity)

        if case .panel(let panel) = state.selection {
            XCTAssertEqual(panel, .identity)
        } else {
            XCTFail("Expected .panel(.identity)")
        }
    }

    func testAvatarCustomizationIsRegisteredInSidePanelType() {
        // Compile-level guard: if .avatarCustomization is removed from SidePanelType,
        // this test will fail to compile.
        let panel: SidePanelType = .avatarCustomization
        XCTAssertEqual(panel, .avatarCustomization)
    }

    func testSelectionTransitionPreservesEquality() {
        let state = MainWindowState(hasAPIKey: false)

        // Start at identity
        state.selection = .panel(.identity)
        let identitySelection = state.selection

        // Transition to avatar customization
        state.selection = .panel(.avatarCustomization)
        let avatarSelection = state.selection

        // Verify they're different
        XCTAssertNotEqual(identitySelection, avatarSelection)

        // Verify specific values
        XCTAssertEqual(identitySelection, .panel(.identity))
        XCTAssertEqual(avatarSelection, .panel(.avatarCustomization))
    }
}
