import Capacitor
import LocalAuthentication
import Security

/// Capacitor plugin that provides biometric-protected Keychain storage for
/// session tokens, enabling Face ID / Touch ID re-authentication.
///
/// The flow:
/// 1. After a successful WorkOS login, JS calls `storeToken` to persist the
///    Django session token in the Keychain with biometric access control.
/// 2. On subsequent app launches, JS calls `retrieveToken` — the plugin
///    authenticates via `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`,
///    which presents Face ID / Touch ID with device passcode as fallback,
///    then passes the authenticated context to the Keychain query.
/// 3. If authentication succeeds, the token is returned and JS restores
///    the session cookie without requiring a full WorkOS re-login.
///
/// Keychain items use `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` with
/// `.userPresence`, meaning:
/// - The item is only accessible when the device is unlocked
/// - Face ID / Touch ID is the primary authentication method
/// - The device passcode is accepted as a fallback (e.g. if biometrics are
///   temporarily unavailable or the user cancels the biometric prompt)
/// - The item never migrates to other devices (no iCloud Keychain sync)
///
/// `.userPresence` was chosen over `.biometryCurrentSet` because:
/// - It prevents users from being locked out if biometrics become unavailable
/// - The enrollment-change protection of `.biometryCurrentSet` is redundant
///   since session tokens are validated server-side and expire independently
/// - Adding a new fingerprint/face already requires the device passcode
///
/// References:
/// - https://developer.apple.com/documentation/localauthentication/accessing_keychain_items_with_face_id_or_touch_id
/// - https://developer.apple.com/documentation/security/secaccesscontrolcreateflags
@objc(NativeBiometricPlugin)
public class NativeBiometricPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBiometricPlugin"
    public let jsName = "NativeBiometric"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retrieveToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteToken", returnType: CAPPluginReturnPromise),
    ]

    private static let keychainService = "ai.vocify-inc.vellum-assistant-ios.biometric-auth"

    // MARK: - isAvailable

    /// Check whether biometric authentication is available on this device.
    /// Returns `{ available: bool, biometryType: "faceId" | "touchId" | "none" }`.
    @objc public func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let canEvaluate = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)

        let biometryType: String
        switch context.biometryType {
        case .none:
            biometryType = "none"
        case .faceID:
            biometryType = "faceId"
        case .touchID:
            biometryType = "touchId"
        case .opticID:
            biometryType = "opticId"
        @unknown default:
            biometryType = "none"
        }

        call.resolve([
            "available": canEvaluate,
            "biometryType": biometryType,
        ])
    }

    // MARK: - storeToken

    /// Store a session token in the Keychain protected by biometrics.
    /// Expects `{ token: string, server: string }`.
    @objc public func storeToken(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("Missing required option: token")
            return
        }
        guard let server = call.getString("server"), !server.isEmpty else {
            call.reject("Missing required option: server")
            return
        }
        guard let tokenData = token.data(using: .utf8) else {
            call.reject("Failed to encode token")
            return
        }

        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .userPresence,
            &accessError
        ) else {
            call.reject("Failed to create access control: \(accessError?.takeRetainedValue().localizedDescription ?? "unknown")")
            return
        }

        // Delete any existing item first (ignore status — item may not exist).
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: NativeBiometricPlugin.keychainService,
            kSecAttrAccount as String: server,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: NativeBiometricPlugin.keychainService,
            kSecAttrAccount as String: server,
            kSecValueData as String: tokenData,
            kSecAttrAccessControl as String: accessControl,
        ]

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Keychain store failed with status: \(status)")
        }
    }

    // MARK: - retrieveToken

    /// Retrieve a biometric-protected session token from the Keychain.
    ///
    /// Authenticates via `LAContext.evaluatePolicy(.deviceOwnerAuthentication)`,
    /// which presents Face ID / Touch ID first and falls back to the device
    /// passcode automatically. The authenticated context is then passed to
    /// `SecItemCopyMatching` via `kSecUseAuthenticationContext`, which
    /// releases the protected Keychain item without re-prompting.
    ///
    /// Expects `{ server: string, reason?: string }`.
    /// Returns `{ token: string }` on success.
    @objc public func retrieveToken(_ call: CAPPluginCall) {
        guard let server = call.getString("server"), !server.isEmpty else {
            call.reject("Missing required option: server")
            return
        }

        let reason = call.getString("reason") ?? "Sign in to Vellum"

        // Preflight: check if a Keychain item exists without triggering
        // biometric auth. An LAContext with interactionNotAllowed = true
        // causes SecItemCopyMatching to return errSecInteractionNotAllowed
        // when the item exists (but is ACL-protected), or errSecItemNotFound
        // when no item is stored. This avoids a spurious Face ID prompt
        // when there's nothing to retrieve.
        let preflightContext = LAContext()
        preflightContext.interactionNotAllowed = true

        let preflight: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: NativeBiometricPlugin.keychainService,
            kSecAttrAccount as String: server,
            kSecUseAuthenticationContext as String: preflightContext,
        ]
        let preflightStatus = SecItemCopyMatching(preflight as CFDictionary, nil)
        guard preflightStatus == errSecInteractionNotAllowed else {
            call.reject("No stored token found", "TOKEN_NOT_FOUND")
            return
        }

        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, authError in
            guard success else {
                let code = (authError as? LAError)?.code
                switch code {
                case .userCancel, .systemCancel, .appCancel:
                    call.reject("Authentication canceled", "AUTH_CANCELED")
                default:
                    call.reject("Authentication failed", "AUTH_FAILED")
                }
                return
            }

            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: NativeBiometricPlugin.keychainService,
                kSecAttrAccount as String: server,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: context,
            ]

            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)

            switch status {
            case errSecSuccess:
                guard let data = result as? Data,
                      let token = String(data: data, encoding: .utf8) else {
                    call.reject("Failed to decode stored token")
                    return
                }
                call.resolve(["token": token])

            case errSecItemNotFound:
                call.reject("No stored token found", "TOKEN_NOT_FOUND")

            default:
                call.reject("Keychain retrieve failed with status: \(status)")
            }
        }
    }

    // MARK: - deleteToken

    /// Delete a stored session token from the Keychain.
    /// Expects `{ server: string }`.
    @objc public func deleteToken(_ call: CAPPluginCall) {
        guard let server = call.getString("server"), !server.isEmpty else {
            call.reject("Missing required option: server")
            return
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: NativeBiometricPlugin.keychainService,
            kSecAttrAccount as String: server,
        ]

        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Keychain delete failed with status: \(status)")
        }
    }
}
