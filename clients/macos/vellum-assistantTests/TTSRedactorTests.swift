import XCTest
@testable import VellumAssistantLib

final class TTSRedactorTests: XCTestCase {

    // MARK: - Anthropic API Keys

    func testRedactsAnthropicKey() {
        let input = "Your key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "Your key is a redacted Anthropic key")
    }

    // MARK: - OpenAI Project Keys

    func testRedactsOpenAIProjectKey() {
        let input = "Use sk-proj-abcdefghijklmnopqrstuvwxyz to authenticate"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "Use a redacted API key to authenticate")
    }

    // MARK: - Generic OpenAI Keys

    func testRedactsGenericOpenAIKey() {
        let input = "sk-abcdefghijklmnopqrstuvwxyz1234"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "a redacted API key")
    }

    // MARK: - GitHub Fine-Grained PATs

    func testRedactsGitHubFinegrainedPAT() {
        let pat = "github_pat_" + String(repeating: "A", count: 82)
        let input = "Token: \(pat)"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "Token: a redacted GitHub token")
    }

    // MARK: - GitHub Classic Tokens

    func testRedactsGitHubClassicPAT() {
        let token = "ghp_" + String(repeating: "A", count: 36)
        let result = TTSRedactor.redact(token)
        XCTAssertEqual(result, "a redacted GitHub token")
    }

    func testRedactsGitHubServerToken() {
        let token = "ghs_" + String(repeating: "B", count: 36)
        let result = TTSRedactor.redact(token)
        XCTAssertEqual(result, "a redacted GitHub token")
    }

    func testRedactsGitHubOAuthToken() {
        let token = "gho_" + String(repeating: "C", count: 36)
        let result = TTSRedactor.redact(token)
        XCTAssertEqual(result, "a redacted GitHub token")
    }

    func testRedactsGitHubRefreshToken() {
        let token = "ghr_" + String(repeating: "D", count: 36)
        let result = TTSRedactor.redact(token)
        XCTAssertEqual(result, "a redacted GitHub token")
    }

    // MARK: - JWT Tokens

    func testRedactsJWTToken() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
        let result = TTSRedactor.redact(jwt)
        XCTAssertEqual(result, "a redacted token")
    }

    // MARK: - Bearer Tokens

    func testRedactsBearerToken() {
        let token = "Bearer " + String(repeating: "x", count: 20)
        let input = "Authorization: \(token)"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "Authorization: a redacted bearer token")
    }

    func testRedactsAuthTokenCaseInsensitive() {
        // Uppercase variant of "Bearer" prefix
        let prefix = "BEARER"
        let token = prefix + " " + String(repeating: "y", count: 20)
        let result = TTSRedactor.redact(token)
        XCTAssertEqual(result, "a redacted bearer token")
    }

    // MARK: - 32-char Alphanumeric Keys

    func testRedacts32CharAlphanumericKey() {
        let key = String(repeating: "Ab1", count: 10) + "Xy"  // 32 chars
        let input = "ElevenLabs key: \(key) is set"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "ElevenLabs key: a redacted key is set")
    }

    // MARK: - Long Hex Strings

    func testRedacts40CharHexString() {
        let hex = String(repeating: "a1b2c3d4e5", count: 4)  // 40 chars
        let input = "SHA1: \(hex)"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "SHA1: a redacted hash")
    }

    func testRedacts64CharHexString() {
        let hex = String(repeating: "abcdef01", count: 8)  // 64 chars
        let input = "Hash: \(hex)"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "Hash: a redacted hash")
    }

    // MARK: - Passthrough (No Credentials)

    func testPassesThroughNormalText() {
        let input = "Hello, how are you today?"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, input)
    }

    func testPassesThroughEmptyString() {
        XCTAssertEqual(TTSRedactor.redact(""), "")
    }

    func testPassesThroughShortAlphanumeric() {
        let input = "The code is ABC123"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, input)
    }

    // MARK: - Multiple Credentials

    func testRedactsMultipleCredentials() {
        let key1 = "sk-ant-api03-" + String(repeating: "x", count: 20)
        let key2 = "ghp_" + String(repeating: "Y", count: 36)
        let input = "Found \(key1) and \(key2) in the config"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "Found a redacted Anthropic key and a redacted GitHub token in the config")
    }

    // MARK: - Credential Embedded in Sentence

    func testRedactsCredentialEmbeddedInSentence() {
        let key = "sk-ant-api03-" + String(repeating: "z", count: 20)
        let input = "I found the key \(key) in your .env file"
        let result = TTSRedactor.redact(input)
        XCTAssertEqual(result, "I found the key a redacted Anthropic key in your .env file")
    }
}
