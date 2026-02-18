import XCTest
import WebKit
@testable import VellumAssistantLib

@MainActor
final class InlineVideoWebViewPolicyTests: XCTestCase {

    // MARK: - Ephemeral data store

    func testConfigurationUsesNonPersistentDataStore() {
        let webView = InlineVideoWebView.makeConfiguredWebView()

        XCTAssertFalse(
            webView.configuration.websiteDataStore.isPersistent,
            "Data store must be non-persistent (ephemeral)"
        )
    }

    // MARK: - Link preview disabled

    func testLinkPreviewIsDisabled() {
        let webView = InlineVideoWebView.makeConfiguredWebView()

        XCTAssertFalse(
            webView.allowsLinkPreview,
            "Link previews must be disabled for inline video embeds"
        )
    }

    // MARK: - URL property

    func testURLIsStoredCorrectly() {
        let url = URL(string: "https://player.vimeo.com/video/76979871")!
        let view = InlineVideoWebView(url: url)

        XCTAssertEqual(view.url, url)
    }

    func testURLPreservesQueryParameters() {
        let url = URL(string: "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=0&mute=1")!
        let view = InlineVideoWebView(url: url)

        XCTAssertEqual(view.url.absoluteString, url.absoluteString)
    }

    // MARK: - Coordinator

    func testCoordinatorConformsToWKNavigationDelegate() {
        let view = InlineVideoWebView(url: URL(string: "https://example.com")!)
        let coordinator = view.makeCoordinator()

        // Verify the coordinator can be used as a WKNavigationDelegate
        let delegate: WKNavigationDelegate = coordinator
        XCTAssertNotNil(delegate)
    }

    // MARK: - Multiple instances are independent

    func testMultipleWebViewsHaveIndependentDataStores() {
        let webViewA = InlineVideoWebView.makeConfiguredWebView()
        let webViewB = InlineVideoWebView.makeConfiguredWebView()

        XCTAssertFalse(webViewA.configuration.websiteDataStore.isPersistent)
        XCTAssertFalse(webViewB.configuration.websiteDataStore.isPersistent)

        // Each non-persistent store is a separate instance
        XCTAssertTrue(
            webViewA.configuration.websiteDataStore !== webViewB.configuration.websiteDataStore,
            "Each webview should get its own ephemeral data store"
        )
    }
}
