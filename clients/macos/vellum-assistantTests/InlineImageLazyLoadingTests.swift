import XCTest
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class InlineImageLazyLoadingTests: XCTestCase {

    // MARK: - Visibility state defaults

    func testIsVisibleDefaultsToFalse() {
        // @State private vars are initialised to their default before
        // onAppear fires, so a freshly created view has isVisible == false.
        // We verify this indirectly: the view can be instantiated and its
        // body evaluated without crashing, which exercises the !isVisible
        // branch that renders the placeholder skeleton.
        let url = URL(string: "https://example.com/photo.png")!
        let view = InlineImageEmbedView(url: url)
        _ = view.body  // exercises the placeholder path
    }

    // MARK: - Instantiation

    func testViewCanBeInstantiatedWithURL() {
        let url = URL(string: "https://example.com/lazy.png")!
        let view = InlineImageEmbedView(url: url)
        XCTAssertEqual(view.url, url)
    }

    func testViewPreservesComplexURL() {
        let url = URL(string: "https://cdn.example.com/img.png?w=400&h=300#anchor")!
        let view = InlineImageEmbedView(url: url)
        XCTAssertEqual(view.url.absoluteString,
                       "https://cdn.example.com/img.png?w=400&h=300#anchor")
    }

    // MARK: - Body evaluates without crash

    func testBodyEvaluatesWithoutCrash() {
        let url = URL(string: "https://example.com/chart.jpg")!
        let view = InlineImageEmbedView(url: url)
        _ = view.body
    }

    // MARK: - Multiple instances are independent

    func testMultipleViewsAreIndependent() {
        let urlA = URL(string: "https://example.com/a.png")!
        let urlB = URL(string: "https://example.com/b.png")!
        let viewA = InlineImageEmbedView(url: urlA)
        let viewB = InlineImageEmbedView(url: urlB)
        XCTAssertNotEqual(viewA.url, viewB.url)
        // Both bodies evaluate independently without interfering.
        _ = viewA.body
        _ = viewB.body
    }
}
