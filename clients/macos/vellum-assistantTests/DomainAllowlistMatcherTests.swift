import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

@MainActor
final class DomainAllowlistMatcherTests: XCTestCase {

    // MARK: - Exact match

    func testExactMatch() {
        let url = URL(string: "https://youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    // MARK: - Subdomain match

    func testSubdomainMatch() {
        let url = URL(string: "https://www.youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    func testDeepSubdomainMatch() {
        let url = URL(string: "https://a.b.youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    // MARK: - No match

    func testNoMatch() {
        let url = URL(string: "https://google.com/search")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    func testPartialMatchRejection() {
        let url = URL(string: "https://notyoutube.com/watch")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    // MARK: - Case insensitivity

    func testCaseInsensitivity() {
        let url = URL(string: "https://WWW.YouTube.COM/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["YOUTUBE.COM"]))
    }

    // MARK: - Empty allowlist

    func testEmptyAllowlistReturnsFalse() {
        let url = URL(string: "https://youtube.com/watch?v=abc")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: []))
    }

    // MARK: - Non-https URL

    func testNonHttpsReturnsFalse() {
        let url = URL(string: "http://youtube.com/watch?v=abc")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    // MARK: - Mixed-case scheme

    func testMixedCaseSchemeIsAccepted() {
        let url = URL(string: "HTTPS://www.youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    // MARK: - URL with no host

    func testNoHostReturnsFalse() {
        let url = URL(string: "https://")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(url, allowedDomains: ["youtube.com"]))
    }

    // MARK: - Multiple domains

    func testMultipleDomainsInAllowlist() {
        let domains = ["youtube.com", "vimeo.com", "loom.com"]

        let youtubeURL = URL(string: "https://www.youtube.com/watch?v=abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(youtubeURL, allowedDomains: domains))

        let vimeoURL = URL(string: "https://vimeo.com/123456")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(vimeoURL, allowedDomains: domains))

        let loomURL = URL(string: "https://www.loom.com/share/abc")!
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(loomURL, allowedDomains: domains))

        let otherURL = URL(string: "https://dailymotion.com/video/abc")!
        XCTAssertFalse(DomainAllowlistMatcher.isAllowed(otherURL, allowedDomains: domains))
    }

    // MARK: - Real provider domains

    func testRealProviderDomains() {
        let providers = ["youtube.com", "youtu.be", "vimeo.com", "loom.com"]

        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(
            URL(string: "https://www.youtube.com/watch?v=dQw4w9WgXcQ")!, allowedDomains: providers))
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(
            URL(string: "https://youtu.be/dQw4w9WgXcQ")!, allowedDomains: providers))
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(
            URL(string: "https://vimeo.com/76979871")!, allowedDomains: providers))
        XCTAssertTrue(DomainAllowlistMatcher.isAllowed(
            URL(string: "https://www.loom.com/share/abc123")!, allowedDomains: providers))
    }
}
