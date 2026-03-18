import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Settings, Schedules, Diagnostics, and Remaining HTTP Dispatchers

/// Registers domain dispatchers for voice config, dictation, tools, OAuth,
/// suggestion, integration config (ingress, vercel), channel verification,
/// workspace files, and all remaining client-to-server message types not
/// covered by the dedicated domain dispatchers or focused clients.
extension HTTPTransport {

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    func registerSettingsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            // --- Voice Config ---
            if let msg = message as? VoiceConfigUpdateRequest {
                Task { await self.sendEncodablePost(.settingsVoice, body: msg, method: "PUT", label: "voice_config_update") }
                return true
            }

            // --- Dictation ---
            if let msg = message as? DictationRequest {
                Task { await self.sendEncodablePost(.dictation, body: msg, label: "dictation_request") }
                return true
            }

            // --- Tools ---
            if message is ToolNamesListMessage {
                Task { await self.sendGenericPost(.tools, method: "GET", label: "tool_names_list") }
                return true
            }
            if let msg = message as? ToolPermissionSimulateMessage {
                Task { await self.sendEncodablePost(.toolsSimulatePermission, body: msg, label: "tool_permission_simulate") }
                return true
            }

            // --- Surface Undo ---
            if message is UiSurfaceUndoMessage {
                // Handled by SurfaceActionClient via GatewayHTTPClient.
                return true
            }

            // --- OAuth ---
            if let msg = message as? OAuthConnectStartRequest {
                Task { await self.sendEncodablePost(.integrationsOAuthStart, body: msg, label: "oauth_connect_start") }
                return true
            }

            // --- Suggestion ---
            if let msg = message as? SuggestionRequest {
                Task { await self.sendSuggestionGetAndDispatch(conversationId: msg.conversationId, requestId: msg.requestId) }
                return true
            }

            // --- Integration Config ---
            if let msg = message as? IngressConfigRequestMessage {
                if msg.action == "get" {
                    Task { await self.sendEncodablePostAndDispatch(.integrationsIngressConfig, body: msg, method: "GET", messageType: "ingress_config_response", label: "ingress_config_get") }
                } else {
                    Task { await self.sendEncodablePostAndDispatch(.integrationsIngressConfig, body: msg, method: "PUT", messageType: "ingress_config_response", label: "ingress_config_set") }
                }
                return true
            }
            // platform_config does not have HTTP routes yet;
            // it continues to use SSE message handlers and is not dispatched here.
            if let msg = message as? VercelApiConfigRequestMessage {
                Task { await self.sendEncodablePost(.integrationsVercelConfig, body: msg, label: "vercel_api_config") }
                return true
            }
            if let msg = message as? ChannelVerificationSessionRequestMessage {
                switch msg.action {
                case "cancel_session":
                    Task { await self.sendEncodablePostAndDispatch(.channelVerificationSessions, body: msg, method: "DELETE", messageType: "channel_verification_session_response", label: "channel_verification_cancel", channel: msg.channel) }
                case "revoke":
                    Task { await self.sendEncodablePostAndDispatch(.channelVerificationSessionsRevoke, body: msg, messageType: "channel_verification_session_response", label: "channel_verification_revoke", channel: msg.channel) }
                case "resend_session":
                    Task { await self.sendEncodablePostAndDispatch(.channelVerificationSessionsResend, body: msg, messageType: "channel_verification_session_response", label: "channel_verification_resend", channel: msg.channel) }
                default:
                    Task { await self.sendEncodablePostAndDispatch(.channelVerificationSessions, body: msg, messageType: "channel_verification_session_response", label: "channel_verification_session", channel: msg.channel) }
                }
                return true
            }
            // --- Workspace Files (legacy HTTP) ---
            if message is WorkspaceFilesListRequestMessage {
                Task { await self.sendGenericPost(.workspaceFiles, method: "GET", label: "workspace_files_list") }
                return true
            }
            if let msg = message as? WorkspaceFileReadRequestMessage {
                Task { await self.sendEncodablePost(.workspaceFilesRead, body: msg, label: "workspace_file_read") }
                return true
            }
            // --- Register Device Token ---
            if let msg = message as? RegisterDeviceTokenMessage {
                Task { await self.sendEncodablePost(.registerDeviceToken, body: msg, label: "register_device_token") }
                return true
            }

            // --- Sign Bundle Payload Response ---
            if let msg = message as? SignBundlePayloadResponseMessage {
                Task { await self.sendEncodablePost(.appsSignBundle, body: msg, label: "sign_bundle_payload_response") }
                return true
            }
            if let msg = message as? GetSigningIdentityResponseMessage {
                Task { await self.sendEncodablePost(.appsSigningIdentity, body: msg, label: "get_signing_identity_response") }
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

    // MARK: - Generic HTTP Helpers

    /// Send a simple HTTP request (no body) to an endpoint.
    func sendGenericPost(_ endpoint: Endpoint, method: String = "POST", label: String) async {
        guard let url = buildURL(for: endpoint) else {
            log.error("Failed to build URL for \(label)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                log.debug("\(label) succeeded via HTTP")
            } else {
                log.error("\(label) failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("\(label) error: \(error.localizedDescription)")
        }
    }

    /// Send an HTTP request with an Encodable body.
    func sendEncodablePost<T: Encodable>(_ endpoint: Endpoint, body: T, method: String = "POST", label: String) async {
        guard var url = buildURL(for: endpoint) else {
            log.error("Failed to build URL for \(label)")
            return
        }

        // GET requests cannot carry a body on macOS (URLError.dataLengthExceedsMaximum).
        // Encode the body's top-level properties as URL query parameters instead.
        if method == "GET" {
            url = appendQueryItems(to: url, from: body)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            if method != "GET" {
                request.httpBody = try encoder.encode(body)
            }
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) {
                log.debug("\(label) succeeded via HTTP")
            } else {
                log.error("\(label) failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("\(label) error: \(error.localizedDescription)")
        }
    }

    /// Send an HTTP request with an Encodable body and dispatch the response
    /// as a `ServerMessage` through the SSE message handler chain.
    ///
    /// HTTP route handlers return plain JSON without the `type` discriminant
    /// that `ServerMessage` decoding requires. This method injects the
    /// `messageType` string before decoding so the existing callback handlers
    /// (e.g. `onChannelVerificationSessionResponse`, `onTelegramConfigResponse`)
    /// fire as expected.
    func sendEncodablePostAndDispatch<T: Encodable>(
        _ endpoint: Endpoint,
        body: T,
        method: String = "POST",
        messageType: String,
        label: String,
        channel: String? = nil
    ) async {
        guard var url = buildURL(for: endpoint) else {
            log.error("Failed to build URL for \(label)")
            return
        }

        // GET requests cannot carry a body on macOS (URLError.dataLengthExceedsMaximum).
        // Encode the body's top-level properties as URL query parameters instead.
        if method == "GET" {
            url = appendQueryItems(to: url, from: body)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            if method != "GET" {
                request.httpBody = try encoder.encode(body)
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return }

            if !(200...299).contains(http.statusCode) {
                log.error("\(label) failed: \(http.statusCode)")
                // Try to extract an error message from the response body,
                // then dispatch a synthetic error so UI callbacks fire and
                // loading states are cleared (avoids infinite spinner).
                var errorMessage = "HTTP \(http.statusCode)"
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let error = json["error"] as? [String: Any],
                   let message = error["message"] as? String {
                    errorMessage = message
                } else if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let message = json["error"] as? String {
                    errorMessage = message
                }
                dispatchSyntheticError(messageType: messageType, errorMessage: errorMessage, channel: channel)
                return
            }

            // Inject the `type` discriminant so ServerMessage can decode it.
            guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                log.error("\(label): failed to parse response JSON")
                return
            }
            json["type"] = messageType
            let enriched = try JSONSerialization.data(withJSONObject: json)
            let serverMessage = try decoder.decode(ServerMessage.self, from: enriched)
            onMessage?(serverMessage)
        } catch {
            log.error("\(label) error: \(error.localizedDescription)")
            dispatchSyntheticError(messageType: messageType, errorMessage: error.localizedDescription, channel: channel)
        }
    }

    /// Build and dispatch a synthetic error `ServerMessage` so UI callbacks
    /// fire and loading states are cleared (avoids infinite spinner).
    private func dispatchSyntheticError(messageType: String, errorMessage: String, channel: String? = nil) {
        var syntheticJSON: [String: Any] = [
            "type": messageType,
            "success": false,
            "error": errorMessage,
        ]
        // TelegramConfigResponse requires these non-optional Bools.
        if messageType == "telegram_config_response" {
            syntheticJSON["hasBotToken"] = false
            syntheticJSON["connected"] = false
            syntheticJSON["hasWebhookSecret"] = false
        }
        // Preserve the channel so SettingsStore can route the response
        // to the correct verification channel handler.
        if let channel {
            syntheticJSON["channel"] = channel
        }
        if let syntheticData = try? JSONSerialization.data(withJSONObject: syntheticJSON),
           let serverMessage = try? decoder.decode(ServerMessage.self, from: syntheticData) {
            onMessage?(serverMessage)
        }
    }

    /// Encode the top-level properties of an `Encodable` value as URL query items.
    /// The `type` key is excluded since it is a message discriminant, not a server parameter.
    private func appendQueryItems<T: Encodable>(to url: URL, from body: T) -> URL {
        guard let data = try? encoder.encode(body),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return url
        }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        var items = components.queryItems ?? []
        for (key, value) in dict {
            if key == "type" { continue }
            let stringValue: String
            if let s = value as? String {
                stringValue = s
            } else if let n = value as? NSNumber {
                if CFGetTypeID(n) == CFBooleanGetTypeID() {
                    stringValue = n.boolValue ? "true" : "false"
                } else {
                    stringValue = n.stringValue
                }
            } else {
                continue
            }
            items.append(URLQueryItem(name: key, value: stringValue))
        }
        if !items.isEmpty {
            components.queryItems = items
        }
        return components.url ?? url
    }

    /// Fetch a follow-up suggestion via GET and dispatch the response through
    /// the message handler chain so `suggestionResponse` fires in the view model.
    private func sendSuggestionGetAndDispatch(conversationId: String, requestId: String) async {
        guard var url = buildURL(for: .suggestion) else {
            log.error("Failed to build URL for suggestion_request")
            return
        }
        if var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            var items = components.queryItems ?? []
            items.append(URLQueryItem(name: "conversationKey", value: conversationId))
            components.queryItems = items
            if let resolved = components.url {
                url = resolved
            }
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return }

            if !(200...299).contains(http.statusCode) {
                log.error("suggestion_request failed: \(http.statusCode)")
                return
            }

            guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                log.error("suggestion_request: failed to parse response JSON")
                return
            }
            json["type"] = "suggestion_response"
            json["requestId"] = requestId
            let enriched = try JSONSerialization.data(withJSONObject: json)
            let serverMessage = try decoder.decode(ServerMessage.self, from: enriched)
            onMessage?(serverMessage)
        } catch {
            log.error("suggestion_request error: \(error.localizedDescription)")
        }
    }
}
