import XCTest
import WebKit
@testable import VellumAssistantLib

@MainActor
final class InlineVideoWebViewNavigationTests: XCTestCase {

    // MARK: - Delegate conformance

    func testCoordinatorConformsToWKNavigationDelegate() {
        let coordinator = InlineVideoWebView.Coordinator()
        XCTAssertTrue(coordinator is WKNavigationDelegate)
    }

    func testCoordinatorConformsToWKUIDelegate() {
        let coordinator = InlineVideoWebView.Coordinator()
        XCTAssertTrue(coordinator is WKUIDelegate)
    }

    // MARK: - Popup blocking

    func testCreateWebViewReturnsNil() {
        let coordinator = InlineVideoWebView.Coordinator()
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)

        let action = WKNavigationAction()
        let features = WKWindowFeatures()

        let result = coordinator.webView(
            webView,
            createWebViewWith: config,
            for: action,
            windowFeatures: features
        )

        XCTAssertNil(result, "Popup windows should be blocked by returning nil")
    }
}
