import XCTest
@testable import VellumAssistantShared

final class AppHostAllowlistTests: XCTestCase {

    // MARK: - normalizeDomains

    func testNormalizeDomains_basicDomain() {
        let result = AppHostAllowlist.normalizeDomains(["example.com"])
        XCTAssertEqual(result, ["example.com"])
    }

    func testNormalizeDomains_trimsWhitespace() {
        let result = AppHostAllowlist.normalizeDomains(["  example.com  ", "\texample.org\n"])
        XCTAssertEqual(result, ["example.com", "example.org"])
    }

    func testNormalizeDomains_lowercases() {
        let result = AppHostAllowlist.normalizeDomains(["Example.COM", "FOO.bar"])
        XCTAssertEqual(result, ["example.com", "foo.bar"])
    }

    func testNormalizeDomains_stripsScheme() {
        let result = AppHostAllowlist.normalizeDomains(["https://example.com", "http://foo.bar"])
        XCTAssertEqual(result, ["example.com", "foo.bar"])
    }

    func testNormalizeDomains_stripsPath() {
        let result = AppHostAllowlist.normalizeDomains(["example.com/path/to/page"])
        XCTAssertEqual(result, ["example.com"])
    }

    func testNormalizeDomains_stripsSchemeAndPath() {
        let result = AppHostAllowlist.normalizeDomains(["https://example.com/path?q=1#frag"])
        XCTAssertEqual(result, ["example.com"])
    }

    func testNormalizeDomains_removesEmptyStrings() {
        let result = AppHostAllowlist.normalizeDomains(["", "  ", "example.com", ""])
        XCTAssertEqual(result, ["example.com"])
    }

    func testNormalizeDomains_deduplicates() {
        let result = AppHostAllowlist.normalizeDomains(["example.com", "EXAMPLE.COM", "example.com"])
        XCTAssertEqual(result, ["example.com"])
    }

    func testNormalizeDomains_preservesOrder() {
        let result = AppHostAllowlist.normalizeDomains(["beta.com", "alpha.com", "gamma.com"])
        XCTAssertEqual(result, ["beta.com", "alpha.com", "gamma.com"])
    }

    // MARK: - isAllowed — exact match

    func testIsAllowed_exactMatch() {
        let url = URL(string: "https://example.com/page")!
        XCTAssertTrue(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    // MARK: - isAllowed — subdomain match

    func testIsAllowed_subdomainMatch() {
        let url = URL(string: "https://www.example.com/page")!
        XCTAssertTrue(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    func testIsAllowed_deepSubdomainMatch() {
        let url = URL(string: "https://a.b.c.example.com/page")!
        XCTAssertTrue(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    // MARK: - isAllowed — non-matching domain

    func testIsAllowed_nonMatchingDomain() {
        let url = URL(string: "https://other.com/page")!
        XCTAssertFalse(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    func testIsAllowed_partialMatchRejected() {
        let url = URL(string: "https://notexample.com/page")!
        XCTAssertFalse(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    // MARK: - isAllowed — scheme handling

    func testIsAllowed_httpRejected() {
        let url = URL(string: "http://example.com/page")!
        XCTAssertFalse(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    func testIsAllowed_ftpRejected() {
        let url = URL(string: "ftp://example.com/file")!
        XCTAssertFalse(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    func testIsAllowed_httpsAllowed() {
        let url = URL(string: "https://example.com")!
        XCTAssertTrue(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    func testIsAllowed_wssAllowed() {
        let url = URL(string: "wss://example.com/socket")!
        XCTAssertTrue(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    func testIsAllowed_wsRejected() {
        let url = URL(string: "ws://example.com/socket")!
        XCTAssertFalse(AppHostAllowlist.isAllowed(url, allowedHosts: ["example.com"]))
    }

    // MARK: - isAllowed — edge cases

    func testIsAllowed_emptyAllowlist() {
        let url = URL(string: "https://example.com")!
        XCTAssertFalse(AppHostAllowlist.isAllowed(url, allowedHosts: []))
    }

    func testIsAllowed_caseInsensitive() {
        let url = URL(string: "https://WWW.Example.COM/page")!
        XCTAssertTrue(AppHostAllowlist.isAllowed(url, allowedHosts: ["EXAMPLE.COM"]))
    }

    // MARK: - contentRuleListJSON

    func testContentRuleListJSON_isValidJSON() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: ["example.com"])
        let data = json.data(using: .utf8)!
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        XCTAssertNotNil(parsed, "Content rule list JSON should be valid JSON")
    }

    func testContentRuleListJSON_containsBlockAllRule() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: [])
        XCTAssertTrue(json.contains("\"url-filter\" : \".*\""), "Should contain block-all trigger")
        XCTAssertTrue(json.contains("\"type\" : \"block\""), "Should contain block action")
    }

    func testContentRuleListJSON_containsVellumAppBypass() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: [])
        // JSONSerialization escapes forward slashes, so vellumapp:// becomes vellumapp:\/\/
        XCTAssertTrue(json.contains("vellumapp:"), "Should contain vellumapp scheme bypass")
    }

    func testContentRuleListJSON_containsAboutBlankBypass() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: [])
        XCTAssertTrue(json.contains("about:blank"), "Should contain about:blank bypass")
    }

    func testContentRuleListJSON_containsHostBypassRules() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: ["example.com", "foo.bar"])
        // JSONSerialization double-escapes backslashes: example\.com becomes example\\.com in JSON
        XCTAssertTrue(json.contains("example\\\\.com"), "Should contain escaped host pattern for example.com")
        XCTAssertTrue(json.contains("foo\\\\.bar"), "Should contain escaped host pattern for foo.bar")
    }

    func testContentRuleListJSON_hostRulesUseIgnorePreviousRules() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: ["example.com"])
        let data = json.data(using: .utf8)!
        let rules = try! JSONSerialization.jsonObject(with: data) as! [[String: Any]]

        // The last rule should be the host bypass rule with ignore-previous-rules action.
        let lastRule = rules.last!
        let action = lastRule["action"] as! [String: String]
        XCTAssertEqual(action["type"], "ignore-previous-rules")
    }

    func testContentRuleListJSON_ruleCount() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: ["a.com", "b.com"])
        let data = json.data(using: .utf8)!
        let rules = try! JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        // 1 block-all + 1 vellumapp + 1 about:blank + 2 hosts = 5
        XCTAssertEqual(rules.count, 5)
    }

    func testContentRuleListJSON_hostPatternMatchesBareDomain() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: ["example.com"])
        // The url-filter should use (/|$) to match bare-domain URLs without trailing slash
        XCTAssertTrue(json.contains("(/|$)"), "Host pattern should use (/|$) to match bare-domain URLs")
        XCTAssertFalse(json.contains("example\\\\.com/\""), "Host pattern should NOT require trailing slash")
    }

    func testContentRuleListJSON_hostPatternIncludesWss() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: ["example.com"])
        // The url-filter should match both https and wss schemes
        XCTAssertTrue(json.contains("(https|wss)"), "Host pattern should match both https and wss schemes")
    }

    func testContentRuleListJSON_emptyHostsStillHasBaseRules() {
        let json = AppHostAllowlist.contentRuleListJSON(allowedHosts: [])
        let data = json.data(using: .utf8)!
        let rules = try! JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        // 1 block-all + 1 vellumapp + 1 about:blank = 3
        XCTAssertEqual(rules.count, 3)
    }
}
