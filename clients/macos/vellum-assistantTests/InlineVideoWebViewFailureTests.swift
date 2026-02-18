import XCTest
import WebKit
@testable import VellumAssistantLib

@MainActor
final class InlineVideoWebViewFailureTests: XCTestCase {

    // MARK: - Coordinator callback wiring

    func testDidFinishTriggersOnLoadSuccess() {
        var called = false
        let coordinator = InlineVideoWebView.Coordinator(
            provider: "youtube",
            onLoadSuccess: { called = true }
        )

        let webView = WKWebView(frame: .zero)
        coordinator.webView(webView, didFinish: nil)

        XCTAssertTrue(called, "onLoadSuccess should be invoked when didFinish fires")
    }

    func testDidFailTriggersOnLoadFailure() {
        var receivedMessage: String?
        let coordinator = InlineVideoWebView.Coordinator(
            provider: "youtube",
            onLoadFailure: { msg in receivedMessage = msg }
        )

        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut, userInfo: [
            NSLocalizedDescriptionKey: "The request timed out.",
        ])
        let webView = WKWebView(frame: .zero)
        coordinator.webView(webView, didFail: nil, withError: error)

        XCTAssertEqual(receivedMessage, "The request timed out.")
    }

    func testDidFailProvisionalNavigationTriggersOnLoadFailure() {
        var receivedMessage: String?
        let coordinator = InlineVideoWebView.Coordinator(
            provider: "youtube",
            onLoadFailure: { msg in receivedMessage = msg }
        )

        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost, userInfo: [
            NSLocalizedDescriptionKey: "A server with the specified hostname could not be found.",
        ])
        let webView = WKWebView(frame: .zero)
        coordinator.webView(webView, didFailProvisionalNavigation: nil, withError: error)

        XCTAssertEqual(receivedMessage, "A server with the specified hostname could not be found.")
    }

    func testNoCallbacksDoesNotCrash() {
        // Coordinator with nil callbacks should not crash when delegate methods fire
        let coordinator = InlineVideoWebView.Coordinator(provider: "youtube")
        let webView = WKWebView(frame: .zero)
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorUnknown)

        coordinator.webView(webView, didFinish: nil)
        coordinator.webView(webView, didFail: nil, withError: error)
        coordinator.webView(webView, didFailProvisionalNavigation: nil, withError: error)
        // No assertion needed — reaching here without crashing is the test.
    }

    // MARK: - Callback update (simulating SwiftUI updateNSView)

    func testCallbacksCanBeUpdatedAfterInit() {
        let coordinator = InlineVideoWebView.Coordinator(provider: "youtube")
        var successCalled = false
        var failureMessage: String?

        coordinator.onLoadSuccess = { successCalled = true }
        coordinator.onLoadFailure = { msg in failureMessage = msg }

        let webView = WKWebView(frame: .zero)
        coordinator.webView(webView, didFinish: nil)
        XCTAssertTrue(successCalled)

        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL, userInfo: [
            NSLocalizedDescriptionKey: "bad URL",
        ])
        coordinator.webView(webView, didFail: nil, withError: error)
        XCTAssertEqual(failureMessage, "bad URL")
    }

    // MARK: - State manager integration

    func testFailureCallbackTransitionsStateManagerToFailed() {
        let stateManager = InlineVideoEmbedStateManager()
        stateManager.requestPlay()
        XCTAssertEqual(stateManager.state, .initializing)

        // Simulate what InlineVideoEmbedCard wires up
        stateManager.didFail("Network error")
        XCTAssertEqual(stateManager.state, .failed("Network error"))
    }

    func testSuccessCallbackTransitionsStateManagerToPlaying() {
        let stateManager = InlineVideoEmbedStateManager()
        stateManager.requestPlay()
        XCTAssertEqual(stateManager.state, .initializing)

        stateManager.didStartPlaying()
        XCTAssertEqual(stateManager.state, .playing)
    }

    func testRetryFromFailedReturnsToInitializing() {
        let stateManager = InlineVideoEmbedStateManager()
        stateManager.requestPlay()
        stateManager.didFail("Timed out")
        XCTAssertEqual(stateManager.state, .failed("Timed out"))

        // Tap-to-retry invokes requestPlay again
        stateManager.requestPlay()
        XCTAssertEqual(stateManager.state, .initializing)
    }

    func testFailureWhilePlayingTransitionsToFailed() {
        let stateManager = InlineVideoEmbedStateManager()
        stateManager.requestPlay()
        stateManager.didStartPlaying()
        XCTAssertEqual(stateManager.state, .playing)

        // A reload failure while already playing should transition to failed
        stateManager.didFail("Connection lost")
        XCTAssertEqual(stateManager.state, .failed("Connection lost"))
    }
}
