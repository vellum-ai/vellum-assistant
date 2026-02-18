import XCTest
@testable import VellumAssistantLib

@MainActor
final class MediaEmbedSettingsDefaultsTests: XCTestCase {

    // MARK: - Default enabled

    func testDefaultEnabledIsTrue() {
        XCTAssertTrue(MediaEmbedSettings.defaultEnabled)
    }

    // MARK: - Default domains

    func testDefaultDomainsContainAllExpectedProviders() {
        let domains = MediaEmbedSettings.defaultDomains
        XCTAssertTrue(domains.contains("youtube.com"), "Should include youtube.com")
        XCTAssertTrue(domains.contains("youtu.be"), "Should include youtu.be")
        XCTAssertTrue(domains.contains("vimeo.com"), "Should include vimeo.com")
        XCTAssertTrue(domains.contains("loom.com"), "Should include loom.com")
        XCTAssertEqual(domains.count, 4, "Should contain exactly 4 default domains")
    }

    // MARK: - enabledSinceNow

    func testEnabledSinceNowReturnsDateCloseToNow() {
        let before = Date()
        let result = MediaEmbedSettings.enabledSinceNow()
        let after = Date()

        XCTAssertGreaterThanOrEqual(result.timeIntervalSince1970, before.timeIntervalSince1970,
                                     "Returned date should not be before the call")
        XCTAssertLessThanOrEqual(result.timeIntervalSince1970, after.timeIntervalSince1970,
                                  "Returned date should not be after the call returns")
    }

    // MARK: - normalizeDomains

    func testNormalizeDomainsTrimsWhitespace() {
        let result = MediaEmbedSettings.normalizeDomains(["  youtube.com  ", " vimeo.com"])
        XCTAssertEqual(result, ["youtube.com", "vimeo.com"])
    }

    func testNormalizeDomainsLowercases() {
        let result = MediaEmbedSettings.normalizeDomains(["YouTube.COM", "Vimeo.Com"])
        XCTAssertEqual(result, ["youtube.com", "vimeo.com"])
    }

    func testNormalizeDomainsDeduplicates() {
        let result = MediaEmbedSettings.normalizeDomains(["youtube.com", "YOUTUBE.COM", "youtube.com"])
        XCTAssertEqual(result, ["youtube.com"])
    }

    func testNormalizeDomainsRemovesEmptyStrings() {
        let result = MediaEmbedSettings.normalizeDomains(["", "youtube.com", "  ", "vimeo.com", ""])
        XCTAssertEqual(result, ["youtube.com", "vimeo.com"])
    }

    func testNormalizeDomainsPreservesFirstOccurrenceOrder() {
        let result = MediaEmbedSettings.normalizeDomains(["loom.com", "youtube.com", "vimeo.com"])
        XCTAssertEqual(result, ["loom.com", "youtube.com", "vimeo.com"])
    }

    func testNormalizeDomainsHandlesEmptyInput() {
        let result = MediaEmbedSettings.normalizeDomains([])
        XCTAssertTrue(result.isEmpty)
    }

    func testNormalizeDomainsHandlesAllEmptyStrings() {
        let result = MediaEmbedSettings.normalizeDomains(["", "  ", "   "])
        XCTAssertTrue(result.isEmpty)
    }

    func testNormalizeDomainsDeduplicatesAcrossCaseAndWhitespace() {
        let result = MediaEmbedSettings.normalizeDomains(["  YouTube.com ", "youtube.com", " YOUTUBE.COM  "])
        XCTAssertEqual(result, ["youtube.com"])
    }

    // MARK: - normalizeDomains — URL stripping

    func testNormalizeDomainsStripsHttpsScheme() {
        let result = MediaEmbedSettings.normalizeDomains(["https://youtube.com"])
        XCTAssertEqual(result, ["youtube.com"])
    }

    func testNormalizeDomainsStripsHttpScheme() {
        let result = MediaEmbedSettings.normalizeDomains(["http://youtube.com"])
        XCTAssertEqual(result, ["youtube.com"])
    }

    func testNormalizeDomainsStripsSchemePathAndQuery() {
        let result = MediaEmbedSettings.normalizeDomains(["https://www.youtube.com/watch?v=abc"])
        XCTAssertEqual(result, ["www.youtube.com"])
    }

    func testNormalizeDomainsStripsPathWithoutScheme() {
        let result = MediaEmbedSettings.normalizeDomains(["youtube.com/path"])
        XCTAssertEqual(result, ["youtube.com"])
    }

    func testNormalizeDomainsStripsFragment() {
        let result = MediaEmbedSettings.normalizeDomains(["https://vimeo.com/video#section"])
        XCTAssertEqual(result, ["vimeo.com"])
    }

    func testNormalizeDomainsPlainDomainUnchanged() {
        let result = MediaEmbedSettings.normalizeDomains(["vimeo.com"])
        XCTAssertEqual(result, ["vimeo.com"])
    }

    func testNormalizeDomainsWhitespacePlusCaseNormalization() {
        let result = MediaEmbedSettings.normalizeDomains(["  YOUTUBE.COM  "])
        XCTAssertEqual(result, ["youtube.com"])
    }

    func testNormalizeDomainsDeduplicatesAfterURLStripping() {
        let result = MediaEmbedSettings.normalizeDomains(["https://youtube.com", "youtube.com"])
        XCTAssertEqual(result, ["youtube.com"])
    }

    func testNormalizeDomainsDeduplicatesFullURLAndPathVariants() {
        let result = MediaEmbedSettings.normalizeDomains([
            "https://youtube.com/watch?v=123",
            "youtube.com/embed",
            "youtube.com",
        ])
        XCTAssertEqual(result, ["youtube.com"])
    }
}
