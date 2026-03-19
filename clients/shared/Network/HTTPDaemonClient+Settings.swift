import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Settings, Schedules, Diagnostics, and Remaining HTTP Dispatchers

/// Registers domain dispatchers for voice config, dictation, tools, OAuth,
/// suggestion, integration config (ingress, vercel), channel verification,
/// workspace files, and all remaining client-to-server message types not
/// covered by the dedicated domain dispatchers or focused clients.
extension HTTPTransport {

    func registerSettingsRoutes() {
        registerDomainDispatcher { message in
            // --- Voice Config ---
            if message is VoiceConfigUpdateRequest {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            }

            // --- Dictation ---
            if message is DictationRequest {
                // Handled by DictationClient via GatewayHTTPClient.
                return true
            }

            // --- Tools ---
            if message is ToolNamesListMessage {
                // Handled by ToolClient via GatewayHTTPClient.
                return true
            }
            if message is ToolPermissionSimulateMessage {
                // Handled by ToolClient via GatewayHTTPClient.
                return true
            }

            // --- Surface Undo ---
            if message is UiSurfaceUndoMessage {
                // Handled by SurfaceActionClient via GatewayHTTPClient.
                return true
            }

            // --- OAuth ---
            if message is OAuthConnectStartRequest {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            }

            // --- Suggestion ---
            if message is SuggestionRequest {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            }

            // --- Integration Config ---
            if message is IngressConfigRequestMessage {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            }

            // --- Workspace Files ---
            if message is WorkspaceFilesListRequestMessage {
                // Handled by WorkspaceClient via GatewayHTTPClient.
                return true
            }
            if message is WorkspaceFileReadRequestMessage {
                // Handled by WorkspaceClient via GatewayHTTPClient.
                return true
            }

            // --- Register Device Token ---
            if message is RegisterDeviceTokenMessage {
                // Handled by SettingsClient via GatewayHTTPClient.
                return true
            }

            // --- Sign Bundle / Signing Identity ---
            if message is SignBundlePayloadResponseMessage {
                // Handled by AppsClient via GatewayHTTPClient.
                return true
            }
            if message is GetSigningIdentityResponseMessage {
                // Handled by AppsClient via GatewayHTTPClient.
                return true
            }

            // --- Auth (transport-level, no-op for HTTP) ---
            if message is AuthMessage {
                // Auth is handled by bearer token in HTTP transport
                return true
            }

            return false
        }
    }
}
