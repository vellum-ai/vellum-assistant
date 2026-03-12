import Foundation
import os
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#else
#error("Unsupported platform")
#endif
import Network

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChatErrorManager")

/// Owns error-related @Published properties that were previously part of ChatViewModel.
/// ChatViewModel holds a reference to this object and forwards reads/writes via
/// computed properties so every existing call site continues to compile without
/// modification.
@MainActor
public final class ChatErrorManager: ObservableObject {

    /// Human-readable error string shown in the error banner.
    @Published public var errorText: String?

    /// Typed session error, richer than `errorText` and used for structured retry UI.
    @Published public var sessionError: SessionError?

    /// Supplemental diagnostic hint shown alongside a daemon connection error.
    /// Nil when no connection error is active or the error has been dismissed.
    @Published public var connectionDiagnosticHint: String? = nil

    // MARK: - Retry state

    /// Whether the current error is a daemon/assistant connection failure.
    @Published public var isConnectionError: Bool = false

    /// Whether the current error is a secret-ingress block that can be bypassed.
    @Published public var isSecretBlockError: Bool = false

    /// Whether the current error is retryable (send failure, not a connection error).
    @Published public var isRetryableError: Bool = false

    /// Whether there is a failed user message that can be retried.
    @Published public var hasRetryPayload: Bool = false

    // MARK: - Connection diagnostics

    /// Map a raw connection error to a short, actionable diagnostic hint.
    ///
    /// The hint is shown below the generic "Failed to connect" error banner so
    /// users can understand *why* the connection failed without opening the
    /// debug panel or contacting support.
    public static func connectionDiagnosticHint(for error: Error) -> String? {
        #if os(macOS)
        if let nwErr = error as? NWError {
            switch nwErr {
            case .posix(let code):
                switch code {
                case .ECONNREFUSED:
                    return "Assistant is not accepting connections — it may still be starting."
                case .ENOENT:
                    return "Assistant socket not found — the assistant may not be running."
                case .ETIMEDOUT:
                    return "Connection timed out — the assistant may be unresponsive or the socket path may be wrong."
                default:
                    return "POSIX error \(code.rawValue): \(nwErr.localizedDescription)"
                }
            default:
                return nwErr.localizedDescription
            }
        }
        if let authErr = error as? DaemonClient.AuthError {
            switch authErr {
            case .missingToken:
                return "Session token not found — try restarting the assistant."
            case .timeout:
                return "Authentication timed out — assistant may be overloaded."
            case .rejected:
                return "Session token rejected — token may have changed; try restarting the assistant."
            }
        }
        #endif
        // HTTP transport / iOS
        if let urlErr = error as? URLError {
            switch urlErr.code {
            case .notConnectedToInternet:
                return "Device is not connected to the internet."
            case .timedOut:
                return "Gateway request timed out — check your host and port."
            case .cannotConnectToHost:
                return "Cannot connect to gateway host — verify the address and that the assistant is running."
            case .networkConnectionLost:
                return "Network connection lost."
            default:
                return urlErr.localizedDescription
            }
        }
        return nil
    }
}
