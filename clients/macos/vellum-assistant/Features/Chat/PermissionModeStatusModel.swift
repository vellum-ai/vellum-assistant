import Combine
import Foundation
import VellumAssistantShared

/// Small view-model for the permission controls popover.
///
/// The toolbar popover should reflect a successful `PUT /v1/permission-mode`
/// response immediately instead of waiting for a follow-up SSE message.
@MainActor
final class PermissionModeStatusModel: ObservableObject {
    @Published private(set) var askBeforeActing: Bool
    @Published private(set) var hostAccess: Bool
    @Published private(set) var isUpdating: Bool = false
    @Published private(set) var lastError: String?

    private let connectionManager: GatewayConnectionManager
    private let permissionModeClient: any PermissionModeClientProtocol
    private var cancellables = Set<AnyCancellable>()

    init(
        connectionManager: GatewayConnectionManager,
        permissionModeClient: any PermissionModeClientProtocol = PermissionModeClient()
    ) {
        self.connectionManager = connectionManager
        self.permissionModeClient = permissionModeClient

        let initialMode = connectionManager.permissionMode
        self.askBeforeActing = initialMode?.askBeforeActing ?? PermissionModeDefaults.askBeforeActing
        self.hostAccess = initialMode?.hostAccess ?? PermissionModeDefaults.hostAccess

        connectionManager.$permissionMode
            .receive(on: RunLoop.main)
            .sink { [weak self] mode in
                guard let self else { return }
                self.askBeforeActing = mode?.askBeforeActing ?? PermissionModeDefaults.askBeforeActing
                self.hostAccess = mode?.hostAccess ?? PermissionModeDefaults.hostAccess
            }
            .store(in: &cancellables)
    }

    func toggleAskBeforeActing() {
        updateMode(askBeforeActing: !askBeforeActing)
    }

    func toggleHostAccess() {
        updateMode(hostAccess: !hostAccess)
    }

    private func updateMode(askBeforeActing: Bool? = nil, hostAccess: Bool? = nil) {
        guard !isUpdating else { return }

        isUpdating = true
        lastError = nil

        Task { @MainActor [weak self] in
            guard let self else { return }
            let response = await self.permissionModeClient.updatePermissionMode(
                askBeforeActing: askBeforeActing,
                hostAccess: hostAccess
            )

            defer { self.isUpdating = false }

            guard let response else {
                self.lastError = "Couldn't update permission controls."
                return
            }

            // Keep the local UI in sync even when the SSE confirmation is late
            // or missing.
            self.connectionManager.permissionMode = response
        }
    }
}
