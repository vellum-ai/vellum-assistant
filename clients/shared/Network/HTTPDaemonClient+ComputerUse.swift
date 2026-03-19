import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Watch & Recording HTTP Dispatchers

/// Registers domain dispatchers for watch observations and recording lifecycle messages.
extension HTTPTransport {

    func registerComputerUseRoutes() {
        registerDomainDispatcher { message in
            if message is WatchObservationMessage {
                // Handled by ComputerUseClient via GatewayHTTPClient.
                return true
            }

            if message is RecordingStatus {
                // Handled by ComputerUseClient via GatewayHTTPClient.
                return true
            }

            return false
        }
    }
}
