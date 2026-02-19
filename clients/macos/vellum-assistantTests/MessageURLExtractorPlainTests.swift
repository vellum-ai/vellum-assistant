import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class MessageURLExtractorPlainTests: XCTestCase {

    // MARK: - Single URL

    func testSingleHTTPSURL() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Visit https://example.com for details")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testSingleHTTPURL() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Go to http://example.com please")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "http://example.com")
    }

    // MARK: - Multiple URLs

    func testMultipleURLsReturnedInOrder() {
        let text = "First https://alpha.com then https://beta.com and https://gamma.com"
        let urls = MessageURLExtractor.extractPlainURLs(from: text)
        XCTAssertEqual(urls.count, 3)
        XCTAssertEqual(urls[0].absoluteString, "https://alpha.com")
        XCTAssertEqual(urls[1].absoluteString, "https://beta.com")
        XCTAssertEqual(urls[2].absoluteString, "https://gamma.com")
    }

    // MARK: - Trailing punctuation

    func testURLFollowedByPeriod() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "See https://example.com.")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testURLFollowedByComma() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Check https://example.com, thanks")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testURLFollowedByExclamation() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Wow https://example.com!")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    // MARK: - Query strings and fragments

    func testURLWithQueryString() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Open https://example.com/search?q=swift&page=2 now")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/search?q=swift&page=2")
    }

    func testURLWithFragment() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "See https://example.com/docs#section-3 for more")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/docs#section-3")
    }

    func testURLWithQueryAndFragment() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Link: https://example.com/page?id=42#top")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/page?id=42#top")
    }

    // MARK: - No URLs

    func testNoURLsReturnsEmptyArray() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Just some plain text with no links.")
        XCTAssertTrue(urls.isEmpty)
    }

    func testEmptyStringReturnsEmptyArray() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "")
        XCTAssertTrue(urls.isEmpty)
    }

    // MARK: - Deduplication

    func testDuplicateURLsReturnedOnce() {
        let text = "See https://example.com and also https://example.com again"
        let urls = MessageURLExtractor.extractPlainURLs(from: text)
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testDuplicateURLsKeepFirstOccurrence() {
        let text = "A: https://first.com B: https://second.com C: https://first.com"
        let urls = MessageURLExtractor.extractPlainURLs(from: text)
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls[0].absoluteString, "https://first.com")
        XCTAssertEqual(urls[1].absoluteString, "https://second.com")
    }

    // MARK: - URL position

    func testURLAtBeginning() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "https://example.com is the site")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testURLAtEnd() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Go to https://example.com")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testURLInMiddle() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Please visit https://example.com for info")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    // MARK: - HTTP vs HTTPS

    func testHTTPAndHTTPSAreSeparateURLs() {
        let text = "http://example.com and https://example.com"
        let urls = MessageURLExtractor.extractPlainURLs(from: text)
        XCTAssertEqual(urls.count, 2)
        XCTAssertEqual(urls[0].absoluteString, "http://example.com")
        XCTAssertEqual(urls[1].absoluteString, "https://example.com")
    }

    // MARK: - Complex URLs

    func testYouTubeURL() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    }

    func testURLWithPath() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Docs at https://example.com/docs/api/v2/users")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/docs/api/v2/users")
    }

    // MARK: - URL-valid characters not stripped

    func testURLWithPortIsPreserved() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Connect to https://example.com:8080/api")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com:8080/api")
    }

    func testURLWithQueryParamQuestionMarkPreserved() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Open https://example.com/search?q=test now")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com/search?q=test")
    }

    func testWikipediaURLWithParensPreserved() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "See https://en.wikipedia.org/wiki/Swift_(programming_language) for info")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://en.wikipedia.org/wiki/Swift_(programming_language)")
    }

    // MARK: - Trailing ? and : trimmed in prose

    func testTrailingQuestionMarkTrimmedInProse() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Have you seen https://example.com?")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    func testTrailingColonTrimmedInProse() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Check out https://example.com: it's great")
        XCTAssertEqual(urls.count, 1)
        XCTAssertEqual(urls.first?.absoluteString, "https://example.com")
    }

    // MARK: - Non-HTTP schemes are excluded

    func testFTPSchemeIsExcluded() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Download from ftp://files.example.com/data.zip")
        XCTAssertTrue(urls.isEmpty)
    }

    func testMailtoSchemeIsExcluded() {
        let urls = MessageURLExtractor.extractPlainURLs(from: "Email user@example.com")
        XCTAssertTrue(urls.isEmpty)
    }
}
