import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostCu")

// MARK: - Host CU Proxy

/// Host CU result posting is now handled by HostProxyClient via GatewayHTTPClient.
/// This file is retained for the domain dispatcher registration.
extension HTTPTransport {}
