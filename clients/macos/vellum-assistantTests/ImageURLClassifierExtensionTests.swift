import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class ImageURLClassifierExtensionTests: XCTestCase {

    // MARK: - Common image extensions

    func testPNG() {
        let url = URL(string: "https://example.com/photo.png")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testJPG() {
        let url = URL(string: "https://example.com/photo.jpg")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testJPEG() {
        let url = URL(string: "https://example.com/photo.jpeg")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testGIF() {
        let url = URL(string: "https://example.com/animation.gif")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testWebP() {
        let url = URL(string: "https://example.com/image.webp")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    // MARK: - Less common image extensions

    func testSVG() {
        let url = URL(string: "https://example.com/icon.svg")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testBMP() {
        let url = URL(string: "https://example.com/legacy.bmp")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testICO() {
        let url = URL(string: "https://example.com/favicon.ico")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testTIFF() {
        let url = URL(string: "https://example.com/scan.tiff")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testTIF() {
        let url = URL(string: "https://example.com/scan.tif")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testAVIF() {
        let url = URL(string: "https://example.com/modern.avif")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testHEIC() {
        let url = URL(string: "https://example.com/apple.heic")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testHEIF() {
        let url = URL(string: "https://example.com/apple.heif")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    // MARK: - Case insensitivity

    func testUppercasePNG() {
        let url = URL(string: "https://example.com/photo.PNG")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testMixedCaseJpG() {
        let url = URL(string: "https://example.com/photo.JpG")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    // MARK: - Query parameters and fragments

    func testImageExtensionWithQueryParameters() {
        let url = URL(string: "https://example.com/image.png?w=100&h=200")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testImageExtensionWithFragment() {
        let url = URL(string: "https://example.com/image.png#section")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    func testImageExtensionWithQueryAndFragment() {
        let url = URL(string: "https://example.com/image.png?size=large#top")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .image)
    }

    // MARK: - HTTP rejected for security

    func testHTTPReturnsNotImage() {
        let url = URL(string: "http://example.com/photo.png")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    // MARK: - Non-image extensions return notImage (skip MIME probe)

    func testHTMLReturnsNotImage() {
        let url = URL(string: "https://example.com/page.html")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    func testPDFReturnsNotImage() {
        let url = URL(string: "https://example.com/document.pdf")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    func testZIPReturnsNotImage() {
        let url = URL(string: "https://example.com/archive.zip")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    // MARK: - No extension returns unknown

    func testNoExtensionReturnsUnknown() {
        let url = URL(string: "https://example.com/image")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .unknown)
    }

    func testExtensionlessPathReturnsUnknown() {
        let url = URL(string: "https://example.com/photos/12345")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .unknown)
    }

    func testRootPathReturnsUnknown() {
        let url = URL(string: "https://example.com/")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .unknown)
    }

    // MARK: - Data URLs

    func testDataURLReturnsNotImage() {
        let url = URL(string: "data:image/png;base64,iVBOR")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    // MARK: - Edge cases

    func testFTPSchemeReturnsNotImage() {
        let url = URL(string: "ftp://example.com/photo.png")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .notImage)
    }

    func testHostOnlyReturnsUnknown() {
        let url = URL(string: "https://example.com")!
        XCTAssertEqual(ImageURLClassifier.classify(url), .unknown)
    }
}
