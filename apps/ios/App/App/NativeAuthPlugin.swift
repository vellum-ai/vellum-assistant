import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import UIKit

/// Capacitor plugin that runs the WorkOS OIDC login flow through
/// `ASWebAuthenticationSession` and returns a session token to JS.
///
/// Why this exists: Google (and many other IdPs) refuse OAuth in embedded
/// WKWebViews with `disallowed_useragent`. The flow is:
///
/// 1. JS calls `NativeAuth.startAuth({ baseURL })`.
/// 2. This plugin generates a random `state`, builds
///    `{baseURL}/accounts/native/start?state={state}`, and opens
///    `ASWebAuthenticationSession`.  The server determines the callback
///    scheme from its environment config (ATL-454).
/// 3. Django's `/accounts/native/start` view initiates the OIDC flow and
///    redirects directly to the WorkOS authorize URL — the user sees only
///    the WorkOS AuthKit UI inside the Safari sheet (no intermediate login
///    page).
/// 4. After authentication, the allauth callback chain redirects through
///    `/accounts/native/callback` which returns
///    `{scheme}://auth/callback?code=<one-time-code>&state=<nonce>`.
/// 5. `ASWebAuthenticationSession` intercepts the custom scheme and hands us
///    back the URL.
/// 6. We verify state, extract `code`, and POST it to
///    `/accounts/native/exchange` to receive the session token.
/// 7. JS sets `document.cookie = "sessionid=<token>; ..."` and navigates;
///    the `AuthProvider` re-fetches `/_allauth/browser/v1/auth/session`
///    and the app is authenticated.
///
/// Reference implementation: `vellum-assistant/clients/shared/App/Auth/
/// AuthManager.swift` (native macOS/iOS). This plugin deliberately does NOT
/// import or depend on that module — it's a standalone port.
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

        // PKCE (RFC 7636): generate code_verifier and code_challenge.
        // The verifier is held in memory and sent with the exchange request;
        // the challenge is sent to /native/start and stored server-side.
        guard let codeVerifier = generateCodeVerifier() else {
            call.reject("Failed to generate PKCE code verifier")
            return
        }
        let codeChallenge = Self.computeCodeChallenge(verifier: codeVerifier)

        // Build `{baseURL}/accounts/native/start?state={state}`.
        // The server determines the callback scheme from its environment
        // config — the client no longer sends it (ATL-454).
        let loginHint = call.getString("loginHint")
        let providerHint = call.getString("providerHint")

        var startComponents = URLComponents()
        startComponents.scheme = baseURL.scheme
        startComponents.host = baseURL.host
        startComponents.port = baseURL.port
        startComponents.path = "/accounts/native/start"
        var queryItems = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
        ]
        if let loginHint = loginHint, !loginHint.isEmpty {
            queryItems.append(URLQueryItem(name: "login_hint", value: loginHint))
        }
        if let providerHint = providerHint, !providerHint.isEmpty {
            queryItems.append(URLQueryItem(name: "provider_hint", value: providerHint))
        }
        // Forward the iOS bundle's short version string for server-side
        // attribution in ``native_login_callback`` (ATL-466). Untrusted by
        // the server — used only for log enrichment, never authorization.
        if let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !clientVersion.isEmpty {
            queryItems.append(URLQueryItem(name: "client_version", value: clientVersion))
        }
        startComponents.queryItems = queryItems

        guard let loginURL = startComponents.url else {
            call.reject("Failed to build login URL")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // Double-tap / concurrent call safety: if a previous session is
            // still alive, cancel it and drop our reference before creating
            // the new one. The cancelled session's completion block fires
            // async with `.canceledLogin` and rejects the earlier
            // `CAPPluginCall`; by the time it runs, `self.authSession`
            // already points at the new session, and the completion
            // deliberately doesn't touch the ivar (see note below) so it
            // can't wipe the new one out.
            self.authSession?.cancel()
            self.authSession = nil

            let session = ASWebAuthenticationSession(
                url: loginURL,
                callbackURLScheme: NativeAuthPlugin.callbackScheme
            ) { [weak self] callbackURL, error in
                // Deliberately NOT clearing `self?.authSession` here: a
                // late-firing completion from a cancelled prior session
                // would otherwise wipe the replacement session that the
                // outer call has since installed. The ivar is cleared only
                // at the top of the next `startAuth` (via the cancel +
                // nil-assign above), or when the plugin deinits. This
                // leaves one `ASWebAuthenticationSession` reference held
                // between a completed flow and the next `startAuth` —
                // trivial memory cost, and safer than an identity check
                // that would require a forward reference to `session`.
                _ = self  // keep [weak self] non-empty for symmetry
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
                // Check for an error param before requiring state — if the
                // server redirects with an error but omits state, the user
                // should see the actual auth error, not "Callback missing state".
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
                guard returnedState == state else {
                    call.reject("State mismatch — possible CSRF; ignoring callback")
                    return
                }

                guard let code = queryItems.first(where: { $0.name == "code" })?.value,
                      !code.isEmpty else {
                    call.reject("Callback missing authorization code")
                    return
                }

                // Exchange the one-time code for a session token via POST.
                // The code is short-lived (30 s) and single-use (ATL-454).
                var exchangeComponents = URLComponents()
                exchangeComponents.scheme = baseURL.scheme
                exchangeComponents.host = baseURL.host
                exchangeComponents.port = baseURL.port
                exchangeComponents.path = "/accounts/native/exchange"

                guard let exchangeURL = exchangeComponents.url else {
                    call.reject("Failed to build exchange URL")
                    return
                }

                var request = URLRequest(url: exchangeURL)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try? JSONSerialization.data(withJSONObject: [
                    "code": code,
                    "code_verifier": codeVerifier,
                ])

                URLSession.shared.dataTask(with: request) { data, response, networkError in
                    if let networkError = networkError {
                        call.reject("Code exchange failed: \(networkError.localizedDescription)")
                        return
                    }
                    guard let httpResponse = response as? HTTPURLResponse else {
                        call.reject("Code exchange returned no HTTP response")
                        return
                    }
                    guard httpResponse.statusCode == 200 else {
                        call.reject("Code exchange failed with status \(httpResponse.statusCode)")
                        return
                    }
                    guard let data = data,
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let sessionToken = json["session_token"] as? String,
                          !sessionToken.isEmpty else {
                        call.reject("Code exchange returned invalid response")
                        return
                    }
                    call.resolve(["sessionToken": sessionToken])
                }.resume()
            }

            // Use an ephemeral (private) session so each auth attempt starts
            // with a clean cookie jar. Without this, stale WorkOS cookies
            // from a previous failed attempt (e.g. signup_closed) cause
            // the IdP to auto-redirect with the same error before the user
            // can interact — creating an infinite error loop. The tradeoff
            // is that users can't leverage an existing Safari Google session
            // for SSO, but the app's own session management (Django session
            // + biometric keychain) handles persistence after the first
            // successful login.
            session.prefersEphemeralWebBrowserSession = true
            session.presentationContextProvider = self

            self.authSession = session
            session.start()
        }
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

    /// PKCE code_verifier: 32 random bytes, base64url-encoded (RFC 7636 § 4.1).
    private func generateCodeVerifier() -> String? {
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

    /// PKCE code_challenge: base64url(SHA-256(code_verifier)) (RFC 7636 § 4.2).
    private static func computeCodeChallenge(verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Data(digest).base64EncodedString()
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
