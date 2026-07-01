import AuthenticationServices
import Capacitor
import Foundation
import UIKit

/// Capacitor plugin that runs app-held WorkOS PKCE login through
/// `ASWebAuthenticationSession` and returns a session token to JS.
///
/// Why this exists: Google (and many other IdPs) refuse OAuth in embedded
/// WKWebViews with `disallowed_useragent`. The flow is:
///
/// 1. JS calls `NativeAuth.startAuth({ baseURL })`.
/// 2. This plugin discovers the WorkOS client id from the platform's
///    `/_allauth/app/v1/config`, generates `state` + a PKCE pair, builds
///    the WorkOS `user_management/authorize` URL (redirect
///    `{scheme}://auth/callback`), and opens `ASWebAuthenticationSession`.
/// 3. The user authenticates in the WorkOS AuthKit UI inside the sheet.
/// 4. WorkOS redirects to `{scheme}://auth/callback?code=…&state=…`, which
///    the session intercepts.
/// 5. We verify `state`, exchange the code at
///    `user_management/authenticate` as a public client (no secret) for an
///    access token, then POST it to `/_allauth/app/v1/auth/provider/token`
///    (`provider: "workos"`) to receive the platform session token.
/// 6. JS sets `document.cookie = "sessionid=<token>; ..."` and navigates;
///    the `AuthProvider` re-fetches `/_allauth/browser/v1/auth/session`
///    and the app is authenticated.
///
/// PKCE / WorkOS contract logic lives in `WorkOSAuth.swift`; this file is
/// the `ASWebAuthenticationSession` + `URLSession` shell.
@objc(NativeAuthPlugin)
public class NativeAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAuthPlugin"
    public let jsName = "NativeAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startAuth", returnType: CAPPluginReturnPromise),
    ]

    /// `ASWebAuthenticationSession` only holds a weak reference to its
    /// presentation context provider and is sensitive to the caller
    /// releasing it before `start()` has fully pumped. Keep it alive
    /// on the plugin instance for the duration of the flow.
    private var authSession: ASWebAuthenticationSession?

    /// Read the URL scheme from the bundle's CFBundleURLTypes rather than
    /// hardcoding it. Each build target (App, App Dev, App Staging) sets
    /// BUNDLE_URL_SCHEME in its xcconfig, which is baked into Info.plist's
    /// CFBundleURLSchemes at build time. Falls back to "vellum-assistant"
    /// if the plist entry is missing or un-substituted.
    private static let callbackScheme: String = {
        guard let urlTypes = Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]],
              let schemes = urlTypes.first?["CFBundleURLSchemes"] as? [String],
              let scheme = schemes.first,
              !scheme.isEmpty,
              !scheme.contains("$")
        else {
            return "vellum-assistant"
        }
        return scheme
    }()

    /// The host this build target is allowed to authenticate against,
    /// read from the `VellumAssociatedDomain` Info.plist key (set per
    /// target via `ASSOCIATED_DOMAIN` in xcconfig). Falls back to
    /// `www.vellum.ai` if the plist entry is missing or un-substituted.
    ///
    /// This prevents non-prod builds from driving production SSO:
    /// a dev build's associated domain is `dev-assistant.vellum.ai`,
    /// so `startAuth({ baseURL: "https://www.vellum.ai" })` is rejected.
    /// See ATL-425.
    private static let allowedAuthHost: String = {
        guard let domain = Bundle.main.infoDictionary?["VellumAssociatedDomain"] as? String,
              !domain.isEmpty,
              !domain.contains("$")
        else {
            return "www.vellum.ai"
        }
        return domain.lowercased()
    }()

    @objc public func startAuth(_ call: CAPPluginCall) {
        guard let baseURLString = call.getString("baseURL"), !baseURLString.isEmpty else {
            call.reject("Missing required option: baseURL")
            return
        }
        guard let baseURL = URL(string: baseURLString), baseURL.scheme != nil else {
            call.reject("Invalid baseURL: \(baseURLString)")
            return
        }
        // Defense in depth: this value is sourced from
        // `window.location.origin` inside the Capacitor shell today, so it's
        // always a vellum.ai host. Validating here means a compromised web
        // bundle or rogue plugin call can't trick the user into
        // authenticating against a phishing login page rendered inside the
        // system auth sheet — the sheet shows the URL, but a plausible-
        // looking URL could still fool someone.
        guard NativeAuthPlugin.isAllowedBaseURL(baseURL) else {
            call.reject("Refusing auth: host \(baseURL.host ?? "<nil>") does not match build target (\(NativeAuthPlugin.allowedAuthHost))")
            return
        }

        guard let state = generateState() else {
            // If SecRandomCopyBytes fails we have no cryptographically random
            // state to protect against CSRF, so refuse rather than fall back
            // to predictable output. In practice this call essentially never
            // fails on iOS — but if the system RNG is genuinely unavailable
            // we want the auth flow to surface it, not silently downgrade.
            call.reject("Failed to generate secure random state")
            return
        }

        let loginHint = call.getString("loginHint")
        let intent = call.getString("intent")

        guard let codeVerifier = WorkOSAuth.generateCodeVerifier() else {
            // Same fail-closed rationale as `state`: no secure RNG, no PKCE.
            call.reject("Failed to generate PKCE code verifier")
            return
        }
        let codeChallenge = WorkOSAuth.codeChallenge(forVerifier: codeVerifier)
        let redirectURI = "\(NativeAuthPlugin.callbackScheme)://auth/callback"

        // Discover the WorkOS client id from the platform's headless config,
        // then open the AuthKit sheet against WorkOS directly. The platform
        // is otherwise only involved in the final session-token exchange.
        fetchWorkOSClientId(baseURL: baseURL) { [weak self] result in
            guard let self = self else { return }
            let clientId: String
            switch result {
            case .success(let id):
                clientId = id
            case .failure(let error):
                call.reject(error.message)
                return
            }

            guard let authorizeURL = WorkOSAuth.buildAuthorizeURL(
                clientId: clientId,
                redirectURI: redirectURI,
                challenge: codeChallenge,
                state: state,
                loginHint: loginHint,
                intent: intent
            ) else {
                call.reject("Failed to build authorize URL")
                return
            }

            DispatchQueue.main.async {
                self.presentAuthSession(
                    authorizeURL: authorizeURL,
                    expectedState: state,
                    baseURL: baseURL,
                    clientId: clientId,
                    codeVerifier: codeVerifier,
                    call: call
                )
            }
        }
    }

    /// Present the AuthKit sheet and, on a state-matched callback, run the
    /// two token exchanges (WorkOS code → access token → platform session).
    /// Must be called on the main thread.
    private func presentAuthSession(
        authorizeURL: URL,
        expectedState: String,
        baseURL: URL,
        clientId: String,
        codeVerifier: String,
        call: CAPPluginCall
    ) {
        // Double-tap / concurrent call safety: cancel any in-flight session
        // before creating the new one. The cancelled session's completion
        // fires async with `.canceledLogin` and rejects the earlier call; by
        // then `authSession` points at the new session, and the completion
        // deliberately doesn't touch the ivar (see below) so it can't wipe
        // the replacement.
        self.authSession?.cancel()
        self.authSession = nil

        let completionHandler: ASWebAuthenticationSession.CompletionHandler = { [weak self] callbackURL, error in
            // Deliberately NOT clearing `self.authSession` here: a late-firing
            // completion from a cancelled prior session would otherwise wipe
            // the replacement the outer call has since installed. Cleared only
            // at the top of the next `startAuth` (cancel + nil above) or on
            // deinit.
            guard let self = self else { return }
            if let authError = error as? ASWebAuthenticationSessionError,
               authError.code == .canceledLogin {
                call.reject("User cancelled login", "USER_CANCELLED")
                return
            }
            if let error = error {
                call.reject("Auth failed: \(error.localizedDescription)")
                return
            }
            guard let callbackURL = callbackURL,
                  let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                  let queryItems = components.queryItems else {
                call.reject("Missing callback URL")
                return
            }
            // Check for an error param before requiring state — if WorkOS
            // redirects with an error but omits state, the user should see
            // the actual auth error, not "Callback missing state".
            if let authError = queryItems.first(where: { $0.name == "error" })?.value,
               !authError.isEmpty {
                call.reject(
                    "Auth error: \(authError)",
                    "AUTH_ERROR",
                    nil,
                    ["authError": authError]
                )
                return
            }
            guard let returnedState = queryItems.first(where: { $0.name == "state" })?.value else {
                call.reject("Callback missing state")
                return
            }
            guard returnedState == expectedState else {
                call.reject("State mismatch — possible CSRF; ignoring callback")
                return
            }
            guard let code = queryItems.first(where: { $0.name == "code" })?.value,
                  !code.isEmpty else {
                call.reject("Callback missing authorization code")
                return
            }

            // Public-client code exchange at WorkOS, then swap the resulting
            // access token for a platform session token.
            self.exchangeCodeWithWorkOS(clientId: clientId, code: code, verifier: codeVerifier) { result in
                let accessToken: String
                switch result {
                case .success(let token):
                    accessToken = token
                case .failure(let error):
                    call.reject(error.message)
                    return
                }
                self.exchangeForSession(baseURL: baseURL, clientId: clientId, accessToken: accessToken) { result in
                    switch result {
                    case .success(let sessionToken):
                        call.resolve(["sessionToken": sessionToken])
                    case .failure(let error):
                        call.reject(error.message)
                    }
                }
            }
        }

        // Use the non-deprecated `callback:` initializer on iOS 17.4+
        let session: ASWebAuthenticationSession
        if #available(iOS 17.4, *) {
            session = ASWebAuthenticationSession(
                url: authorizeURL,
                callback: .customScheme(NativeAuthPlugin.callbackScheme),
                completionHandler: completionHandler
            )
        } else {
            session = ASWebAuthenticationSession(
                url: authorizeURL,
                callbackURLScheme: NativeAuthPlugin.callbackScheme,
                completionHandler: completionHandler
            )
        }

        // Ephemeral (private) session: a clean cookie jar per attempt. Without
        // it, stale WorkOS cookies from a prior failed attempt auto-redirect
        // with the same error before the user can interact (infinite error
        // loop). The tradeoff — no Safari SSO cookie reuse — is acceptable
        // since the app persists its own session token after first login.
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = self

        self.authSession = session
        session.start()
    }

    private struct AuthFlowError: Error {
        let message: String
    }

    /// GET the headless config and pick the token-auth WorkOS client id.
    private func fetchWorkOSClientId(
        baseURL: URL,
        completion: @escaping (Result<String, AuthFlowError>) -> Void
    ) {
        var components = URLComponents()
        components.scheme = baseURL.scheme
        components.host = baseURL.host
        components.port = baseURL.port
        components.path = "/_allauth/app/v1/config"
        guard let url = components.url else {
            completion(.failure(AuthFlowError(message: "Failed to build config URL")))
            return
        }
        URLSession.shared.dataTask(with: url) { data, response, error in
            if let error = error {
                completion(.failure(AuthFlowError(message: "Failed to fetch auth config: \(error.localizedDescription)")))
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data else {
                completion(.failure(AuthFlowError(message: "Failed to fetch auth config")))
                return
            }
            guard let clientId = WorkOSAuth.selectClientId(fromConfig: data) else {
                completion(.failure(AuthFlowError(message: "Platform does not advertise a token-auth WorkOS provider")))
                return
            }
            completion(.success(clientId))
        }.resume()
    }

    /// Exchange the authorization code at WorkOS as a public client (no
    /// secret, no API key).
    private func exchangeCodeWithWorkOS(
        clientId: String,
        code: String,
        verifier: String,
        completion: @escaping (Result<String, AuthFlowError>) -> Void
    ) {
        guard let url = URL(string: "\(WorkOSAuth.apiBaseURL)/user_management/authenticate"),
              let body = WorkOSAuth.authenticateRequestBody(clientId: clientId, code: code, verifier: verifier) else {
            completion(.failure(AuthFlowError(message: "Failed to build WorkOS token request")))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(AuthFlowError(message: "WorkOS code exchange failed: \(error.localizedDescription)")))
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
                  let accessToken = WorkOSAuth.accessToken(fromAuthenticate: data) else {
                completion(.failure(AuthFlowError(message: "WorkOS code exchange returned no access token")))
                return
            }
            completion(.success(accessToken))
        }.resume()
    }

    /// Exchange the WorkOS access token for a platform session token via the
    /// headless `provider/token` endpoint.
    private func exchangeForSession(
        baseURL: URL,
        clientId: String,
        accessToken: String,
        completion: @escaping (Result<String, AuthFlowError>) -> Void
    ) {
        var components = URLComponents()
        components.scheme = baseURL.scheme
        components.host = baseURL.host
        components.port = baseURL.port
        components.path = "/_allauth/app/v1/auth/provider/token"
        guard let url = components.url,
              let body = WorkOSAuth.providerTokenRequestBody(clientId: clientId, accessToken: accessToken) else {
            completion(.failure(AuthFlowError(message: "Failed to build session exchange request")))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(AuthFlowError(message: "Session exchange failed: \(error.localizedDescription)")))
                return
            }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
                  let sessionToken = WorkOSAuth.sessionToken(fromProviderToken: data) else {
                completion(.failure(AuthFlowError(message: "Session exchange returned invalid response")))
                return
            }
            completion(.success(sessionToken))
        }.resume()
    }

    /// True only if `url`'s host exactly matches this build target's
    /// `ASSOCIATED_DOMAIN` (read from Info.plist at launch). A dev build
    /// only authenticates against `dev-assistant.vellum.ai`, staging
    /// against `staging-assistant.vellum.ai`, and production against
    /// `www.vellum.ai`. This is the primary defense against ATL-425:
    /// non-prod JS cannot drive production SSO because the host check
    /// rejects `www.vellum.ai` in non-prod builds.
    private static func isAllowedBaseURL(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased(), !host.isEmpty else { return false }
        return host == allowedAuthHost
    }

    /// 32 random bytes, base64url-encoded without padding. Mirrors the
    /// `state` generation on the Django + macOS side so both ends stay in
    /// the same namespace (alphabet is `A-Za-z0-9-_`).
    ///
    /// Returns `nil` on RNG failure. Callers must treat that as a fatal
    /// condition — the state is the sole CSRF defense on the auth
    /// callback, so a deterministic fallback (e.g. the all-zero
    /// `repeating: 0` buffer) would undermine security.
    private func generateState() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            return nil
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension NativeAuthPlugin: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let keyWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow })

        if let keyWindow = keyWindow {
            return keyWindow
        }

        // Should be unreachable — a Capacitor app always has the bridge
        // view controller in the key window by the time JS can call us —
        // but log loudly if it ever happens so it's visible in the Xcode
        // console rather than manifesting as a silently-non-presenting
        // auth sheet.
        NSLog("[NativeAuthPlugin] presentationAnchor: no key window found; auth sheet may fail to present")
        return ASPresentationAnchor()
    }
}
