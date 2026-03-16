import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class SecretPromptManagerTests: XCTestCase {

    private var manager: SecretPromptManager!
    private var responses: [(requestId: String, value: String?, delivery: String?)] = []

    override func setUp() {
        super.setUp()
        manager = SecretPromptManager()
        manager.panelPresenter = { _ in /* suppress UI popups during tests */ }
        responses = []
        manager.onResponse = { [unowned self] requestId, value, delivery in
            self.responses.append((requestId: requestId, value: value, delivery: delivery))
            return true
        }
    }

    override func tearDown() {
        manager.dismissAll()
        manager = nil
        responses = []
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeRequest(
        requestId: String = "r1",
        description: String? = nil,
        purpose: String? = nil,
        allowedTools: [String]? = nil,
        allowedDomains: [String]? = nil,
        allowOneTimeSend: Bool? = nil
    ) -> SecretRequest {
        SecretRequest(
            type: "secret_request",
            requestId: requestId,
            service: "github",
            field: "token",
            label: "GitHub Token",
            description: description,
            placeholder: nil,
            conversationId: nil,
            purpose: purpose,
            allowedTools: allowedTools,
            allowedDomains: allowedDomains,
            allowOneTimeSend: allowOneTimeSend
        )
    }

    // MARK: - Panel creation with context variations

    func testPanelCreatedWithNoContext() {
        manager.showPrompt(makeRequest())
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    func testPanelCreatedWithPurposeOnly() {
        manager.showPrompt(makeRequest(purpose: "Sign in to GitHub"))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    func testPanelCreatedWithToolsOnly() {
        manager.showPrompt(makeRequest(allowedTools: ["browser_fill_credential"]))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    func testPanelCreatedWithDomainsOnly() {
        manager.showPrompt(makeRequest(allowedDomains: ["github.com", "api.github.com"]))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    func testPanelCreatedWithFullContext() {
        manager.showPrompt(makeRequest(
            description: "Enter your GitHub token",
            purpose: "Authenticate with GitHub API",
            allowedTools: ["browser_fill_credential"],
            allowedDomains: ["github.com"]
        ))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    func testPanelCreatedWithEmptyArrayContext() {
        manager.showPrompt(makeRequest(allowedTools: [], allowedDomains: []))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    // MARK: - Existing behavior preserved

    func testDismissRemovesPanel() {
        manager.showPrompt(makeRequest())
        XCTAssertNotNil(manager.panelForRequest("r1"))
        manager.dismissPrompt(requestId: "r1")
        XCTAssertNil(manager.panelForRequest("r1"))
    }

    func testDismissAllClearsAllPanels() {
        manager.showPrompt(makeRequest(requestId: "r1"))
        manager.showPrompt(makeRequest(requestId: "r2", purpose: "Test"))
        XCTAssertNotNil(manager.panelForRequest("r1"))
        XCTAssertNotNil(manager.panelForRequest("r2"))
        manager.dismissAll()
        XCTAssertNil(manager.panelForRequest("r1"))
        XCTAssertNil(manager.panelForRequest("r2"))
    }

    func testShowPromptReplacesExistingPanel() {
        manager.showPrompt(makeRequest())
        let panel1 = manager.panelForRequest("r1")
        manager.showPrompt(makeRequest(purpose: "Updated"))
        let panel2 = manager.panelForRequest("r1")
        XCTAssertNotNil(panel2)
        XCTAssertTrue(panel1 !== panel2, "Should create a new panel, not reuse the old one")
    }

    // MARK: - One-time send affordance

    func testPanelCreatedWithOneTimeSendEnabled() {
        manager.showPrompt(makeRequest(allowOneTimeSend: true))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }

    func testPanelCreatedWithOneTimeSendDisabled() {
        manager.showPrompt(makeRequest(allowOneTimeSend: false))
        XCTAssertNotNil(manager.panelForRequest("r1"))
    }
}
