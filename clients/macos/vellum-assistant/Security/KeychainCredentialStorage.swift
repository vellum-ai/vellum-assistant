#if os(macOS)
import Foundation
import VellumAssistantShared

/// Bridges KeychainBrokerService to the CredentialStorage protocol
/// used by LocalAssistantBootstrapService.
struct KeychainCredentialStorage: CredentialStorage {
    func get(account: String) -> String? {
        KeychainBrokerService.get(account: account)
    }
    func set(account: String, value: String) -> Bool {
        KeychainBrokerService.set(account: account, value: value) == errSecSuccess
    }
    func delete(account: String) -> Bool {
        KeychainBrokerService.delete(account: account)
    }
}
#endif
