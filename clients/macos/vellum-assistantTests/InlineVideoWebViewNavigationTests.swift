import XCTest
import WebKit
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class InlineVideoWebViewNavigationTests: XCTestCase {

    // MARK: - Delegate conformance

    func testCoordinatorConformsToWKNavigationDelegate() {
        let coordinator = InlineVideoWebView.Coordinator(provider: "youtube")
        XCTAssertTrue(coordinator as Any is WKNavigationDelegate)
    }

    func testCoordinatorConformsToWKUIDelegate() {
        let coordinator = InlineVideoWebView.Coordinator(provider: "youtube")
        XCTAssertTrue(coordinator as Any is WKUIDelegate)
    }

    // MARK: - Popup blocking

    func testCreateWebViewReturnsNil() {
        let coordinator = InlineVideoWebView.Coordinator(provider: "youtube")
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

    // MARK: - Initial request

    func testYouTubeInitialRequestIncludesReferer() {
        let request = InlineVideoWebView.makeRequest(
            url: URL(string: "https://www.youtube.com/embed/abc123")!,
            provider: "youtube"
        )

        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Referer"),
            VideoEmbedRequestBuilder.defaultReferer
        )
    }

    func testVimeoInitialRequestOmitsReferer() {
        let request = InlineVideoWebView.makeRequest(
            url: URL(string: "https://player.vimeo.com/video/123")!,
            provider: "vimeo"
        )

        XCTAssertNil(request.value(forHTTPHeaderField: "Referer"))
    }

    // MARK: - Host allowlist (static helper)

    func testYouTubeEmbedHostAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("www.youtube.com", forProvider: "youtube"),
            "www.youtube.com should be allowed for youtube provider"
        )
    }

    func testYouTubeExactHostAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("youtube.com", forProvider: "youtube"),
            "youtube.com should be allowed for youtube provider"
        )
    }

    func testYouTubeCDNSubresourceAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("r4---sn-abc.googlevideo.com", forProvider: "youtube"),
            "googlevideo.com subdomains should be allowed for youtube provider"
        )
    }

    func testYouTubeWildcardRootMatchAllowed() {
        // *.googlevideo.com should also match "googlevideo.com" itself
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("googlevideo.com", forProvider: "youtube"),
            "googlevideo.com root should match *.googlevideo.com wildcard"
        )
    }

    func testYouTubeYtimgAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("i.ytimg.com", forProvider: "youtube"),
            "ytimg.com subdomains should be allowed for youtube provider"
        )
    }

    func testYouTubeGstaticAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("fonts.gstatic.com", forProvider: "youtube"),
            "gstatic.com subdomains should be allowed for youtube provider"
        )
    }

    func testArbitraryDomainBlockedForYouTube() {
        XCTAssertFalse(
            InlineVideoWebView.isAllowedHost("evil.com", forProvider: "youtube"),
            "evil.com should not be allowed for youtube provider"
        )
    }

    func testVimeoEmbedHostAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("player.vimeo.com", forProvider: "vimeo"),
            "player.vimeo.com should be allowed for vimeo provider"
        )
    }

    func testVimeoCDNAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("f.vimeocdn.com", forProvider: "vimeo"),
            "vimeocdn.com subdomains should be allowed for vimeo provider"
        )
    }

    func testVimeoAkamaizedAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("skyfire.vimeocdn.akamaized.net", forProvider: "vimeo"),
            "akamaized.net subdomains should be allowed for vimeo provider"
        )
    }

    func testArbitraryDomainBlockedForVimeo() {
        XCTAssertFalse(
            InlineVideoWebView.isAllowedHost("evil.com", forProvider: "vimeo"),
            "evil.com should not be allowed for vimeo provider"
        )
    }

    func testLoomEmbedHostAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("www.loom.com", forProvider: "loom"),
            "www.loom.com should be allowed for loom provider"
        )
    }

    func testLoomCDNAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("cdn.loom.com", forProvider: "loom"),
            "cdn.loom.com should be allowed for loom provider"
        )
    }

    func testLoomCDNSubdomainAllowed() {
        XCTAssertTrue(
            InlineVideoWebView.isAllowedHost("assets.loomcdn.com", forProvider: "loom"),
            "loomcdn.com subdomains should be allowed for loom provider"
        )
    }

    func testArbitraryDomainBlockedForLoom() {
        XCTAssertFalse(
            InlineVideoWebView.isAllowedHost("evil.com", forProvider: "loom"),
            "evil.com should not be allowed for loom provider"
        )
    }

    func testUnknownProviderBlocksEverything() {
        XCTAssertFalse(
            InlineVideoWebView.isAllowedHost("youtube.com", forProvider: "unknown"),
            "Unknown provider should block all hosts"
        )
    }

    // MARK: - Cross-provider isolation

    func testYouTubeHostBlockedForVimeoProvider() {
        XCTAssertFalse(
            InlineVideoWebView.isAllowedHost("www.youtube.com", forProvider: "vimeo"),
            "YouTube host should not be allowed for vimeo provider"
        )
    }

    func testVimeoHostBlockedForYouTubeProvider() {
        XCTAssertFalse(
            InlineVideoWebView.isAllowedHost("player.vimeo.com", forProvider: "youtube"),
            "Vimeo host should not be allowed for youtube provider"
        )
    }
}
