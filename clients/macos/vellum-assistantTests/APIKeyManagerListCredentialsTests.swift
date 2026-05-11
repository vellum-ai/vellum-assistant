import XCTest
@testable import VellumAssistantLib

/// Covers ``APIKeyManager/parseListCredentialsResponse(_:)`` — the shape
/// handling for `GET /v1/secrets` when populating the credential reference
/// dropdown in ProvidersSheet.
final class APIKeyManagerListCredentialsTests: XCTestCase {

    // MARK: - Empty payload

    func testReturnsEmptyArrayForEmptySecretsArray() {
        let json = """
        { "secrets": [] }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)

        XCTAssertEqual(result?.count, 0)
    }

    func testReturnsNilForUnparseablePayload() {
        let garbage = Data("not json".utf8)
        XCTAssertNil(APIKeyManager.parseListCredentialsResponse(garbage))
    }

    // MARK: - secrets / accounts alias

    func testParsesFromSecretsField() {
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "anthropic" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "anthropic")
        XCTAssertEqual(result[0].field, "api_key")
    }

    func testFallsBackToAccountsAliasWhenSecretsMissing() {
        let json = """
        {
          "accounts": [
            { "type": "api_key", "name": "openai" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "openai")
        XCTAssertEqual(result[0].field, "api_key")
    }

    func testPrefersSecretsOverAccountsAlias() {
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "anthropic" }
          ],
          "accounts": [
            { "type": "api_key", "name": "openai" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "anthropic")
    }

    // MARK: - api_key entries

    func testApiKeyEntryMapsToServiceAndApiKeyField() {
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "gemini" },
            { "type": "api_key", "name": "openrouter" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 2)
        XCTAssertTrue(result.contains(where: { $0.service == "gemini" && $0.field == "api_key" }))
        XCTAssertTrue(result.contains(where: { $0.service == "openrouter" && $0.field == "api_key" }))
    }

    func testSkipsApiKeyEntriesWithEmptyName() {
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "" },
            { "type": "api_key", "name": "anthropic" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "anthropic")
    }

    // MARK: - credential entries

    func testCredentialEntryWithColonSeparatorParsesServiceAndField() {
        let json = """
        {
          "secrets": [
            { "type": "credential", "name": "elevenlabs:api_key" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "elevenlabs")
        XCTAssertEqual(result[0].field, "api_key")
    }

    func testCredentialEntryUsesLastColonAsSeparator() {
        let json = """
        {
          "secrets": [
            { "type": "credential", "name": "some:nested:field" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "some:nested")
        XCTAssertEqual(result[0].field, "field")
    }

    // MARK: - Mixed entries

    func testMixedApiKeyAndCredentialEntries() {
        let json = """
        {
          "secrets": [
            { "type": "api_key", "name": "anthropic" },
            { "type": "credential", "name": "elevenlabs:api_key" },
            { "type": "api_key", "name": "openai" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 3)
        XCTAssertTrue(result.contains(where: { $0.service == "anthropic" && $0.field == "api_key" }))
        XCTAssertTrue(result.contains(where: { $0.service == "elevenlabs" && $0.field == "api_key" }))
        XCTAssertTrue(result.contains(where: { $0.service == "openai" && $0.field == "api_key" }))
    }

    // MARK: - Malformed entries

    func testSkipsEntriesMissingType() {
        let json = """
        {
          "secrets": [
            { "name": "anthropic" },
            { "type": "api_key", "name": "openai" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "openai")
    }

    func testSkipsCredentialEntryWithNoColonInName() {
        let json = """
        {
          "secrets": [
            { "type": "credential", "name": "nocolon" },
            { "type": "api_key", "name": "anthropic" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "anthropic")
    }

    func testSkipsCredentialEntryWithEmptyServiceAfterSplit() {
        let json = """
        {
          "secrets": [
            { "type": "credential", "name": ":api_key" },
            { "type": "api_key", "name": "anthropic" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "anthropic")
    }

    func testSkipsCredentialEntryWithEmptyFieldAfterSplit() {
        let json = """
        {
          "secrets": [
            { "type": "credential", "name": "elevenlabs:" },
            { "type": "api_key", "name": "anthropic" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "anthropic")
    }

    func testSkipsCredentialEntryMissingNameKey() {
        let json = """
        {
          "secrets": [
            { "type": "credential" },
            { "type": "api_key", "name": "openai" }
          ]
        }
        """.data(using: .utf8)!

        let result = APIKeyManager.parseListCredentialsResponse(json)!

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].service, "openai")
    }
}
