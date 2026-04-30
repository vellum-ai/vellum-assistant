import CryptoKit
import Foundation
import Security
import VellumAssistantShared

struct PKCE {
    let verifier: String
    let challenge: String
}

enum PKCEHelper {
    static func generate() -> PKCE {
        let verifier = randomBytes(count: 32).base64URLEncodedString()
        let hash = SHA256.hash(data: Data(verifier.utf8))
        let challenge = Data(hash).base64URLEncodedString()
        return PKCE(verifier: verifier, challenge: challenge)
    }

    static func randomState() -> String {
        randomBytes(count: 16).map { String(format: "%02x", $0) }.joined()
    }

    private static func randomBytes(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }
}
