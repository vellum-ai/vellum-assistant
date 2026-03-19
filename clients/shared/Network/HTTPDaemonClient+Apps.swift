import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Apps Domain Dispatcher

extension HTTPTransport {

    func registerAppsRoutes() {
        registerDomainDispatcher { message in
            if message is AppDataRequestMessage {
                // Handled by AppsClient via GatewayHTTPClient.
                return true
            }

            return false
        }
    }
}
