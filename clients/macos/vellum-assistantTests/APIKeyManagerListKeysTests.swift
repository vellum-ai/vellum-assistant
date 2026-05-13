import XCTest
@testable import VellumAssistantLib

/// Covers ``APIKeyManager/parseListKeysResponse(_:)`` — the shape handling
/// for `GET /v1/secrets`. The HTTP wrapper itself is exercised end-to-end
/// against a real daemon in the settings layer; here we just want to be
/// sure we tolerate the daemon's `secrets`/`accounts` alias and ignore
/// non-`api_key` entries.
final class APIKeyManagerListKeysTests: XCTestCase {
    func testParsesApiKeyEntriesFromSecretsField() throws {
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "anthropic" },
            { "type": "api_key", "name": "openai" }
          ],
          "accounts": [
            { "type": "api_key", "name": "anthropic" },
            { "type": "api_key", "name": "openai" }
          ]
        }
        """.data(using: .utf8)!

        let names = APIKeyManager.parseListKeysResponse(json)

        XCTAssertEqual(names, Set(["anthropic", "openai"]))
    }

    func testFallsBackToAccountsAliasWhenSecretsMissing() throws {
        // Older daemons may only return `accounts`. Treat it as authoritative
        // when `secrets` is absent so we don't regress on rolling deploys.
        let json = """
        {
          "accounts": [
            { "type": "api_key", "name": "gemini" }
          ]
        }
        """.data(using: .utf8)!

        let names = APIKeyManager.parseListKeysResponse(json)

        XCTAssertEqual(names, Set(["gemini"]))
    }

    func testFiltersOutNonApiKeyEntries() throws {
        // OAuth/credential entries share the same listing endpoint but are
        // not BYOK provider keys — `listKeys` callers (settings presence
        // checks, migration) only care about `api_key` rows.
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "anthropic" },
            { "type": "credential", "name": "github:token" },
            { "type": "credential", "name": "slack:bot_token" }
          ]
        }
        """.data(using: .utf8)!

        let names = APIKeyManager.parseListKeysResponse(json)

        XCTAssertEqual(names, Set(["anthropic"]))
    }

    func testReturnsEmptySetWhenNoEntries() throws {
        let json = """
        { "secrets": [], "accounts": [] }
        """.data(using: .utf8)!

        let names = APIKeyManager.parseListKeysResponse(json)

        XCTAssertEqual(names, Set<String>())
    }

    func testReturnsNilOnUnparseablePayload() throws {
        let garbage = Data("not json".utf8)
        XCTAssertNil(APIKeyManager.parseListKeysResponse(garbage))
    }

    func testIgnoresEntriesMissingNameOrType() throws {
        let json = """
        {
          "secrets": [
            { "type": "api_key" },
            { "type": "api_key", "name": "" },
            { "name": "openai" },
            { "type": "api_key", "name": "anthropic" }
          ]
        }
        """.data(using: .utf8)!

        let names = APIKeyManager.parseListKeysResponse(json)

        XCTAssertEqual(names, Set(["anthropic"]))
    }
}
