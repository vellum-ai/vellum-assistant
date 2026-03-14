import Foundation
import VellumAssistantShared

/// Resolves the connected assistant from the lockfile (`~/.vellum.lock.json`).
///
/// Reads the `connectedAssistantId` from UserDefaults and looks up the
/// corresponding entry in the lockfile to provide connection info.
struct LockfileAssistantResolver: ConnectedAssistantResolver {
    func resolve() -> ConnectedAssistantInfo? {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty else { return nil }
        guard let assistant = LockfileAssistant.loadByName(id) else { return nil }
        return ConnectedAssistantInfo(
            assistantId: assistant.assistantId,
            gatewayPort: assistant.gatewayPort,
            isManaged: assistant.isManaged,
            isRemote: assistant.isRemote,
            runtimeUrl: assistant.runtimeUrl
        )
    }
}
