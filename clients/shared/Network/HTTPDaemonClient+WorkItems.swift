import Foundation

// MARK: - Work Items Domain Dispatcher

extension HTTPTransport {

    /// All work-item HTTP operations are now handled by ``WorkItemClient``
    /// via ``GatewayHTTPClient``. This dispatcher is intentionally empty.
    func registerWorkItemsRoutes() {
        // No-op — retained so the call site in HTTPTransport.init does not
        // need to be modified until all domain dispatchers are removed.
    }
}
