import XCTest
@testable import VellumAssistantShared

final class WebSearchProviderRegistryTests: XCTestCase {

    func testCatalogContainsExpectedProvidersInOrder() {
        let ids = WebSearchProviderRegistry.providers.map(\.id)
        XCTAssertEqual(
            ids,
            ["inference-provider-native", "perplexity", "brave", "tavily"]
        )
    }

    func testCatalogVersionIsOne() {
        XCTAssertEqual(WebSearchProviderRegistry.shared.version, 1)
    }

    func testManagedProviderHasNoByokFields() {
        guard let native = WebSearchProviderRegistry.provider(id: "inference-provider-native") else {
            return XCTFail("Expected inference-provider-native in bundled catalog")
        }
        XCTAssertEqual(native.kind, .managed)
        XCTAssertFalse(native.isByok)
        XCTAssertNil(native.apiKeyPrefix)
        XCTAssertNil(native.envVar)
        XCTAssertNil(native.secretKey)
        XCTAssertNil(native.fallbackOrder)
        XCTAssertNil(native.privacyPolicyUrl)
    }

    func testByokProviderCarriesFullMetadata() {
        guard let perplexity = WebSearchProviderRegistry.provider(id: "perplexity") else {
            return XCTFail("Expected perplexity in bundled catalog")
        }
        XCTAssertEqual(perplexity.displayName, "Perplexity")
        XCTAssertEqual(perplexity.kind, .byok)
        XCTAssertTrue(perplexity.isByok)
        XCTAssertEqual(perplexity.envVar, "PERPLEXITY_API_KEY")
        XCTAssertEqual(perplexity.secretKey, "perplexity")
        XCTAssertEqual(perplexity.fallbackOrder, 1)
        XCTAssertEqual(perplexity.apiKeyPrefix, "pplx-...")
        XCTAssertEqual(
            perplexity.privacyPolicyUrl,
            "https://www.perplexity.ai/hub/legal/privacy-policy"
        )
    }

    func testBraveExposesLongDisplayNameForMarketingProse() {
        guard let brave = WebSearchProviderRegistry.provider(id: "brave") else {
            return XCTFail("Expected brave in bundled catalog")
        }
        XCTAssertEqual(brave.displayName, "Brave")
        XCTAssertEqual(brave.displayNameLong, "Brave Search")
    }

    func testProviderIdsHelperMatchesCatalogOrder() {
        XCTAssertEqual(
            WebSearchProviderRegistry.providerIds,
            WebSearchProviderRegistry.providers.map(\.id)
        )
    }

    func testDisplayNamesByIdCoversEveryProvider() {
        let names = WebSearchProviderRegistry.displayNamesById
        for provider in WebSearchProviderRegistry.providers {
            XCTAssertEqual(names[provider.id], provider.displayName)
        }
        XCTAssertEqual(names.count, WebSearchProviderRegistry.providers.count)
    }

    func testLookupForUnknownIdReturnsNil() {
        XCTAssertNil(WebSearchProviderRegistry.provider(id: "definitely-not-a-provider"))
    }

    func testFallbackOrderValuesAreUniqueAcrossByokProviders() {
        let orders = WebSearchProviderRegistry.providers
            .compactMap { $0.fallbackOrder }
            .sorted()
        XCTAssertEqual(orders, Array(Set(orders)).sorted())
        // Sanity: all BYOK providers carry a fallbackOrder.
        let byokCount = WebSearchProviderRegistry.providers.filter(\.isByok).count
        XCTAssertEqual(orders.count, byokCount)
    }
}
