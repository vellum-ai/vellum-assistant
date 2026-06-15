import CryptoKit
import Foundation
import XCTest

@testable import VellumAssistantShared

final class WorkOSPKCETests: XCTestCase {
    // MARK: - PKCE pair

    func test_generatePkcePair_isS256AndBase64URL() throws {
        let pair = try XCTUnwrap(WorkOSPKCE.generatePkcePair())

        // Verifier is base64url(32 bytes) → 43 chars, no padding/url-unsafe.
        XCTAssertEqual(pair.verifier.count, 43)
        XCTAssertFalse(pair.verifier.contains("="))
        XCTAssertFalse(pair.verifier.contains("+"))
        XCTAssertFalse(pair.verifier.contains("/"))

        // Challenge must equal base64url(SHA256(verifier)).
        let expected = Data(SHA256.hash(data: Data(pair.verifier.utf8)))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertEqual(pair.challenge, expected)
    }

    func test_randomBase64URLString_lengthAndAlphabet() throws {
        let value = try XCTUnwrap(WorkOSPKCE.randomBase64URLString(byteCount: 32))
        XCTAssertEqual(value.count, 43)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        XCTAssertTrue(value.unicodeScalars.allSatisfy { allowed.contains($0) })
    }

    func test_pkcePairs_areUnique() throws {
        let a = try XCTUnwrap(WorkOSPKCE.generatePkcePair())
        let b = try XCTUnwrap(WorkOSPKCE.generatePkcePair())
        XCTAssertNotEqual(a.verifier, b.verifier)
        XCTAssertNotEqual(a.challenge, b.challenge)
    }

    // MARK: - Provider selection

    private func entry(
        id: String = "workos-oidc",
        clientID: String?,
        flows: [String]?,
        oidcURL: String?
    ) -> WorkOSPKCE.ProviderEntry {
        WorkOSPKCE.ProviderEntry(
            id: id,
            name: nil,
            client_id: clientID,
            flows: flows,
            openid_configuration_url: oidcURL
        )
    }

    func test_selectWorkosClientId_picksOAuth2DuringCoexistence() {
        // Two `workos-oidc` entries: the legacy OIDC one (has discovery URL)
        // and the new OAuth2 one (provider_token flow, no discovery URL).
        let providers = [
            entry(clientID: "oidc_client", flows: ["provider_redirect"], oidcURL: "https://api.workos.com/sso/oidc/.well-known"),
            entry(clientID: "oauth2_client", flows: ["provider_token", "provider_redirect"], oidcURL: nil),
        ]
        XCTAssertEqual(WorkOSPKCE.selectWorkosClientId(providers), "oauth2_client")
    }

    func test_selectWorkosClientId_nilWhenOnlyOIDC() {
        let providers = [
            entry(clientID: "oidc_client", flows: ["provider_token"], oidcURL: "https://discovery"),
        ]
        XCTAssertNil(WorkOSPKCE.selectWorkosClientId(providers))
    }

    func test_selectWorkosClientId_nilWhenNoProviderToken() {
        let providers = [
            entry(clientID: "oauth2_client", flows: ["provider_redirect"], oidcURL: nil),
        ]
        XCTAssertNil(WorkOSPKCE.selectWorkosClientId(providers))
    }

    func test_selectWorkosClientId_nilWhenNoClientId() {
        let providers = [
            entry(clientID: nil, flows: ["provider_token"], oidcURL: nil),
        ]
        XCTAssertNil(WorkOSPKCE.selectWorkosClientId(providers))
    }

    func test_selectWorkosClientId_emptyList() {
        XCTAssertNil(WorkOSPKCE.selectWorkosClientId([]))
    }

    // MARK: - Config decoding

    func test_configResponse_decodesAndSelects() throws {
        let json = """
        {
          "status": 200,
          "data": {
            "socialaccount": {
              "providers": [
                {"id": "workos-oidc", "name": "WorkOS", "client_id": "oidc", "flows": ["provider_redirect"], "openid_configuration_url": "https://disc"},
                {"id": "workos-oidc", "name": "WorkOS", "client_id": "client_abc", "flows": ["provider_token", "provider_redirect"]}
              ]
            }
          }
        }
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(WorkOSPKCE.ConfigResponse.self, from: json)
        let providers = try XCTUnwrap(response.data?.socialaccount?.providers)
        XCTAssertEqual(WorkOSPKCE.selectWorkosClientId(providers), "client_abc")
    }

    // MARK: - Authorize URL

    func test_buildAuthorizeURL_hasExpectedParams() throws {
        let url = try WorkOSPKCE.buildAuthorizeURL(
            clientID: "client_abc",
            redirectURI: "vellum-assistant://auth/callback",
            challenge: "the-challenge",
            state: "the-state"
        )
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "api.workos.com")
        XCTAssertEqual(components.path, "/user_management/authorize")

        let items = Dictionary(
            uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value) }
        )
        XCTAssertEqual(items["client_id"], "client_abc")
        XCTAssertEqual(items["redirect_uri"], "vellum-assistant://auth/callback")
        XCTAssertEqual(items["response_type"], "code")
        XCTAssertEqual(items["scope"], "openid profile email")
        XCTAssertEqual(items["code_challenge"], "the-challenge")
        XCTAssertEqual(items["code_challenge_method"], "S256")
        XCTAssertEqual(items["state"], "the-state")
        XCTAssertEqual(items["provider"], "authkit")
        // No `prompt` param so the browser IdP session can be reused.
        XCTAssertNil(items["prompt"])
    }

    // MARK: - Redirect URI

    func test_redirectURI_prod() {
        XCTAssertEqual(
            WorkOSPKCE.redirectURI(scheme: "vellum-assistant"),
            "vellum-assistant://auth/callback"
        )
    }

    func test_redirectURI_dev() {
        XCTAssertEqual(
            WorkOSPKCE.redirectURI(scheme: "vellum-assistant-dev"),
            "vellum-assistant-dev://auth/callback"
        )
    }

    // MARK: - Callback parsing

    func test_extractCode_success() throws {
        let url = URL(string: "vellum-assistant://auth/callback?code=abc123&state=expected")!
        XCTAssertEqual(try WorkOSPKCE.extractCode(from: url, expectedState: "expected"), "abc123")
    }

    func test_extractCode_stateMismatchThrows() {
        let url = URL(string: "vellum-assistant://auth/callback?code=abc&state=wrong")!
        XCTAssertThrowsError(try WorkOSPKCE.extractCode(from: url, expectedState: "expected")) {
            guard case WorkOSPKCE.PkceError.stateMismatch = $0 else {
                return XCTFail("expected stateMismatch, got \($0)")
            }
        }
    }

    func test_extractCode_errorParamThrowsBeforeMissingState() {
        let url = URL(string: "vellum-assistant://auth/callback?error=access_denied")!
        XCTAssertThrowsError(try WorkOSPKCE.extractCode(from: url, expectedState: "expected")) {
            guard case WorkOSPKCE.PkceError.callbackError(let detail) = $0 else {
                return XCTFail("expected callbackError, got \($0)")
            }
            XCTAssertEqual(detail, "access_denied")
        }
    }

    func test_extractCode_missingCodeThrows() {
        let url = URL(string: "vellum-assistant://auth/callback?state=expected")!
        XCTAssertThrowsError(try WorkOSPKCE.extractCode(from: url, expectedState: "expected")) {
            guard case WorkOSPKCE.PkceError.callbackMissingCode = $0 else {
                return XCTFail("expected callbackMissingCode, got \($0)")
            }
        }
    }

    // MARK: - Request bodies & URLs

    func test_codeExchangeBody_isPublicClient() {
        let body = WorkOSPKCE.codeExchangeBody(clientID: "c", code: "code", verifier: "v")
        XCTAssertEqual(body["client_id"] as? String, "c")
        XCTAssertEqual(body["grant_type"] as? String, "authorization_code")
        XCTAssertEqual(body["code"] as? String, "code")
        XCTAssertEqual(body["code_verifier"] as? String, "v")
        // No secret / API key.
        XCTAssertNil(body["client_secret"])
        XCTAssertNil(body["api_key"])
    }

    func test_sessionExchangeBody_shape() {
        let body = WorkOSPKCE.sessionExchangeBody(clientID: "c", accessToken: "at")
        XCTAssertEqual(body["provider"] as? String, "workos")
        XCTAssertEqual(body["process"] as? String, "login")
        let token = body["token"] as? [String: String]
        XCTAssertEqual(token?["client_id"], "c")
        XCTAssertEqual(token?["access_token"], "at")
    }

    func test_configURL_appendsPathAndStripsQuery() {
        let url = WorkOSPKCE.configURL(platformOrigin: "https://platform.vellum.ai/some/path?x=1")
        XCTAssertEqual(url?.absoluteString, "https://platform.vellum.ai/_allauth/app/v1/config")
    }

    func test_sessionExchangeURL_appendsPath() {
        let url = WorkOSPKCE.sessionExchangeURL(platformOrigin: "http://localhost:8000")
        XCTAssertEqual(url?.absoluteString, "http://localhost:8000/_allauth/app/v1/auth/provider/token")
    }

    func test_codeExchangeURL() {
        XCTAssertEqual(
            WorkOSPKCE.codeExchangeURL()?.absoluteString,
            "https://api.workos.com/user_management/authenticate"
        )
    }

    // MARK: - Response parsing

    func test_parseAccessToken_success() throws {
        let data = #"{"access_token": "tok_123", "user": {"id": "u"}}"#.data(using: .utf8)!
        XCTAssertEqual(try WorkOSPKCE.parseAccessToken(data), "tok_123")
    }

    func test_parseAccessToken_missingThrows() {
        let data = #"{"error": "invalid_grant"}"#.data(using: .utf8)!
        XCTAssertThrowsError(try WorkOSPKCE.parseAccessToken(data))
    }

    func test_parseSessionToken_success() throws {
        let data = #"{"status": 200, "meta": {"session_token": "sess_abc", "is_authenticated": true}}"#.data(using: .utf8)!
        XCTAssertEqual(try WorkOSPKCE.parseSessionToken(data), "sess_abc")
    }

    func test_parseSessionToken_missingThrows() {
        let data = #"{"status": 200, "meta": {"is_authenticated": false}}"#.data(using: .utf8)!
        XCTAssertThrowsError(try WorkOSPKCE.parseSessionToken(data))
    }
}
