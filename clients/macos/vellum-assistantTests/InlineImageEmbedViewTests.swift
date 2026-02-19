import XCTest
import SwiftUI
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class InlineImageEmbedViewTests: XCTestCase {

    // MARK: - Instantiation

    func testViewCanBeInstantiatedWithURL() {
        let url = URL(string: "https://example.com/photo.png")!
        let view = InlineImageEmbedView(url: url)
        XCTAssertEqual(view.url, url)
    }

    func testViewStoresCorrectURL() {
        let url = URL(string: "https://cdn.example.com/images/chart.jpg")!
        let view = InlineImageEmbedView(url: url)
        XCTAssertEqual(view.url.absoluteString, "https://cdn.example.com/images/chart.jpg")
    }

    func testViewPreservesURLWithQueryParameters() {
        let url = URL(string: "https://example.com/img.png?width=800&format=webp")!
        let view = InlineImageEmbedView(url: url)
        XCTAssertEqual(view.url.query, "width=800&format=webp")
    }

    func testViewPreservesURLWithFragment() {
        let url = URL(string: "https://example.com/photo.png#section")!
        let view = InlineImageEmbedView(url: url)
        XCTAssertEqual(view.url.fragment, "section")
    }

    // MARK: - Body renders without crashing

    func testBodyDoesNotThrow() {
        let url = URL(string: "https://example.com/photo.png")!
        let view = InlineImageEmbedView(url: url)
        // Accessing body forces SwiftUI to evaluate the view tree.
        // If the view graph is malformed this will trap at runtime.
        _ = view.body
    }

    func testMultipleInstancesAreIndependent() {
        let urlA = URL(string: "https://example.com/a.png")!
        let urlB = URL(string: "https://example.com/b.jpg")!
        let viewA = InlineImageEmbedView(url: urlA)
        let viewB = InlineImageEmbedView(url: urlB)
        XCTAssertNotEqual(viewA.url, viewB.url)
    }
}
