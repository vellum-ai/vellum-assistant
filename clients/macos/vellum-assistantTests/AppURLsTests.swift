import XCTest
@testable import vellum_assistant

final class AppURLsTests: XCTestCase {
    private var originalEnvValue: String?

    override func setUp() {
        super.setUp()
        originalEnvValue = ProcessInfo.processInfo.environment["VELLUM_DOCS_BASE_URL"]
        unsetenv("VELLUM_DOCS_BASE_URL")
    }

    override func tearDown() {
        if let value = originalEnvValue {
            setenv("VELLUM_DOCS_BASE_URL", value, 1)
        } else {
            unsetenv("VELLUM_DOCS_BASE_URL")
        }
        super.tearDown()
    }

    // MARK: - Base URL behavior

    func testDocsBaseURLDefaultsToProduction() {
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.vellum.ai/docs")
    }

    func testDocsBaseURLHonorsEnvOverride() {
        setenv("VELLUM_DOCS_BASE_URL", "https://staging.vellum.ai/docs", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://staging.vellum.ai/docs")
    }

    func testDocsBaseURLStripsTrailingSlash() {
        setenv("VELLUM_DOCS_BASE_URL", "https://staging.vellum.ai/docs/", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://staging.vellum.ai/docs")
    }

    func testDocsBaseURLEmptyEnvFallsBackToDefault() {
        setenv("VELLUM_DOCS_BASE_URL", "  ", 1)
        XCTAssertEqual(AppURLs.docsBaseURL, "https://www.vellum.ai/docs")
    }

    // MARK: - Concrete URL constructions

    func testPricingDocsURLConstruction() {
        XCTAssertEqual(AppURLs.pricingDocs.absoluteString, "https://www.vellum.ai/docs/pricing")
    }

    func testHostingOptionsDocsURLConstruction() {
        XCTAssertEqual(AppURLs.hostingOptionsDocs.absoluteString, "https://www.vellum.ai/docs/hosting-options")
    }

    func testTermsOfUseDocsURLConstruction() {
        XCTAssertEqual(AppURLs.termsOfUseDocs.absoluteString, "https://www.vellum.ai/docs/vellum-terms-of-use")
    }

    func testPrivacyPolicyDocsURLConstruction() {
        XCTAssertEqual(AppURLs.privacyPolicyDocs.absoluteString, "https://www.vellum.ai/docs/privacy-policy")
    }

    // MARK: - Env override propagates to concrete URLs

    func testConcreteURLsHonorEnvOverride() {
        setenv("VELLUM_DOCS_BASE_URL", "https://staging.vellum.ai/docs", 1)
        XCTAssertEqual(AppURLs.pricingDocs.absoluteString, "https://staging.vellum.ai/docs/pricing")
        XCTAssertEqual(AppURLs.hostingOptionsDocs.absoluteString, "https://staging.vellum.ai/docs/hosting-options")
        XCTAssertEqual(AppURLs.termsOfUseDocs.absoluteString, "https://staging.vellum.ai/docs/vellum-terms-of-use")
        XCTAssertEqual(AppURLs.privacyPolicyDocs.absoluteString, "https://staging.vellum.ai/docs/privacy-policy")
    }

    // MARK: - UTM helper

    func testUTMHelperBuildsBaseURLWithQueryParams() {
        let url = AppURLs.docsURL(utmSource: "macos-app", utmMedium: "help-menu")
        XCTAssertEqual(url.absoluteString, "https://www.vellum.ai/docs?utm_source=macos-app&utm_medium=help-menu")
    }

    func testUTMHelperWithPath() {
        let url = AppURLs.docsURL(path: "/pricing", utmSource: "macos-app", utmMedium: "settings")
        XCTAssertEqual(url.absoluteString, "https://www.vellum.ai/docs/pricing?utm_source=macos-app&utm_medium=settings")
    }

    func testUTMHelperHonorsEnvOverride() {
        setenv("VELLUM_DOCS_BASE_URL", "https://staging.vellum.ai/docs", 1)
        let url = AppURLs.docsURL(utmSource: "macos-app", utmMedium: "help-menu")
        XCTAssertEqual(url.absoluteString, "https://staging.vellum.ai/docs?utm_source=macos-app&utm_medium=help-menu")
    }

    // MARK: - Path helper

    func testDocsURLHelperNormalizesLeadingSlash() {
        XCTAssertEqual(AppURLs.docsURL(path: "/pricing").absoluteString, "https://www.vellum.ai/docs/pricing")
        XCTAssertEqual(AppURLs.docsURL(path: "pricing").absoluteString, "https://www.vellum.ai/docs/pricing")
    }
}
