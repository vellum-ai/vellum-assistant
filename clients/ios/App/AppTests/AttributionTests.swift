import XCTest

/// Covers the pure `Attribution` helper in `App/Attribution.swift`, which the
/// provider-token exchange uses to put campaign params on the wire.
///
/// Mirrors `AttributionTest.java` in the Android shell. The allowlist and
/// truncation length themselves are pinned to the web source of truth by
/// `clients/ios/scripts/__tests__/attribution-allowlist.test.ts`, so they are
/// not restated here.
final class AttributionTests: XCTestCase {
    func testFieldsKeepsOnlyAllowlistedKeys() {
        let fields = Attribution.fields(from: [
            "utm_source": "google",
            "gclid": "abc123",
            "callback_url": "https://evil.example",
            "provider": "not-workos",
        ])
        XCTAssertEqual(fields, ["utm_source": "google", "gclid": "abc123"])
    }

    func testFieldsDropsEmptyAndNonStringValues() {
        let fields = Attribution.fields(from: [
            "utm_source": "",
            "utm_medium": 42,
            "utm_campaign": "spring",
        ])
        XCTAssertEqual(fields, ["utm_campaign": "spring"])
    }

    func testFieldsTruncatesToValueMaxLength() {
        let long = String(repeating: "a", count: Attribution.valueMaxLength + 40)
        let fields = Attribution.fields(from: ["utm_campaign": long])
        XCTAssertEqual(fields["utm_campaign"]?.count, Attribution.valueMaxLength)
    }

    func testFieldsFromNilIsEmpty() {
        XCTAssertEqual(Attribution.fields(from: nil), [:])
        XCTAssertEqual(Attribution.fields(from: [:]), [:])
    }

    func testQueryEmitsInAllowlistOrder() {
        let query = Attribution.query(from: [
            "twclid": "tw",
            "utm_medium": "cpc",
            "utm_source": "google",
        ])
        XCTAssertEqual(query, "utm_source=google&utm_medium=cpc&twclid=tw")
    }

    func testQueryPercentEncodesReservedCharacters() {
        let query = Attribution.query(from: ["utm_campaign": "spring sale&x=1+2/é"])
        XCTAssertEqual(query, "utm_campaign=spring%20sale%26x%3D1%2B2%2F%C3%A9")
    }

    /// A `+` must survive as a literal plus: Django decodes an unencoded one
    /// back to a space.
    func testQueryRoundTripsThroughURLComponents() {
        var components = URLComponents(string: "https://www.vellum.ai/x")!
        components.percentEncodedQuery = Attribution.query(from: [
            "utm_campaign": "spring sale",
            "utm_term": "a+b",
        ])
        XCTAssertEqual(
            components.queryItems,
            [
                URLQueryItem(name: "utm_campaign", value: "spring sale"),
                URLQueryItem(name: "utm_term", value: "a+b"),
            ]
        )
    }

    func testQueryIsEmptyWhenNothingSurvives() {
        XCTAssertEqual(Attribution.query(from: [:]), "")
        XCTAssertEqual(Attribution.query(from: ["utm_source": ""]), "")
        XCTAssertEqual(Attribution.query(from: ["unknown": "x"]), "")
    }
}
