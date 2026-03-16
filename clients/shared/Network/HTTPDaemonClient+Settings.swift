import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Settings, Schedules, Diagnostics, and Remaining HTTP Dispatchers

/// Registers domain dispatchers for identity, voice config, avatar generation,
/// schedules, diagnostics, dictation, tools, OAuth, suggestion, heartbeat,
/// pairing, integration config, publishing, link open, workspace files,
/// and all remaining client-to-server message types not covered by the
/// dedicated domain dispatchers (Sessions, Skills, Apps, Documents,
/// WorkItems, Subagents, ComputerUse).
extension HTTPTransport {

    // swiftlint:disable:next function_body_length cyclomatic_complexity
    func registerSettingsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            // --- Identity ---
            if message is IdentityGetRequestMessage {
                Task { await self.sendGenericPost(.identity, method: "GET", label: "identity_get") }
                return true
            }

            // --- Voice Config ---
            if let msg = message as? VoiceConfigUpdateRequest {
                Task { await self.sendEncodablePost(.settingsVoice, body: msg, method: "PUT", label: "voice_config_update") }
                return true
            }

            // --- Avatar Generate ---
            if let msg = message as? GenerateAvatarRequestMessage {
                Task { await self.sendEncodablePost(.settingsAvatarGenerate, body: msg, label: "generate_avatar") }
                return true
            }

            // --- Schedules ---
            if message is SchedulesListMessage {
                Task { await self.sendGenericPost(.schedules, method: "GET", label: "schedules_list") }
                return true
            }
            if let msg = message as? ScheduleToggleMessage {
                Task { await self.sendEncodablePost(.scheduleToggle(id: msg.id), body: msg, label: "schedule_toggle") }
                return true
            }
            if let msg = message as? ScheduleRemoveMessage {
                Task { await self.sendGenericPost(.scheduleDelete(id: msg.id), method: "DELETE", label: "schedule_remove") }
                return true
            }
            if let msg = message as? ScheduleCancelMessage {
                Task { await self.sendGenericPost(.scheduleCancel(id: msg.id), label: "schedule_cancel") }
                return true
            }
            if let msg = message as? ScheduleRunNowMessage {
                Task { await self.sendGenericPost(.scheduleRunNow(id: msg.id), label: "schedule_run_now") }
                return true
            }

            // --- Diagnostics ---
            if let msg = message as? DiagnosticsExportRequestMessage {
                Task { await self.sendDiagnosticsExport(msg) }
                return true
            }
            if message is EnvVarsRequestMessage {
                Task { await self.sendGenericPost(.diagnosticsEnvVars, method: "GET", label: "env_vars_request") }
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
            if let msg = message as? UiSurfaceUndoMessage {
                Task { await self.sendEncodablePost(.surfaceUndo(surfaceId: msg.surfaceId), body: msg, label: "ui_surface_undo") }
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

            // --- Heartbeat ---
            if let msg = message as? HeartbeatConfig {
                if msg.action == "get" {
                    Task { await self.sendGenericPost(.heartbeatConfig, method: "GET", label: "heartbeat_config_get") }
                } else {
                    Task { await self.sendEncodablePost(.heartbeatConfig, body: msg, method: "PUT", label: "heartbeat_config_set") }
                }
                return true
            }
            if let msg = message as? HeartbeatRunsList {
                Task { await self.sendEncodablePost(.heartbeatRuns, body: msg, method: "GET", label: "heartbeat_runs_list") }
                return true
            }
            if message is HeartbeatRunNow {
                Task { await self.sendGenericPost(.heartbeatRunNow, label: "heartbeat_run_now") }
                return true
            }
            if message is HeartbeatChecklistRead {
                Task { await self.sendGenericPost(.heartbeatChecklist, method: "GET", label: "heartbeat_checklist_read") }
                return true
            }
            if let msg = message as? HeartbeatChecklistWrite {
                Task { await self.sendEncodablePost(.heartbeatChecklistWrite, body: msg, method: "PUT", label: "heartbeat_checklist_write") }
                return true
            }

            // --- Pairing ---
            if let msg = message as? PairingApprovalResponseMessage {
                Task { await self.sendEncodablePost(.pairingRegister, body: msg, label: "pairing_approval_response") }
                return true
            }
            if message is ApprovedDevicesListMessage {
                Task { await self.sendGenericPost(.pairingRegister, method: "GET", label: "approved_devices_list") }
                return true
            }
            if let msg = message as? ApprovedDeviceRemoveMessage {
                Task { await self.sendEncodablePost(.pairingRegister, body: msg, method: "DELETE", label: "approved_device_remove") }
                return true
            }
            if message is ApprovedDevicesClearMessage {
                Task { await self.sendGenericPost(.pairingRegister, method: "DELETE", label: "approved_devices_clear") }
                return true
            }

            // --- Integration Config ---
            if let msg = message as? SlackWebhookConfigRequestMessage {
                Task { await self.sendEncodablePost(.integrationsSlackConfig, body: msg, label: "slack_webhook_config") }
                return true
            }
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
            if let msg = message as? TelegramConfigRequestMessage {
                switch msg.action {
                case "get":
                    Task { await self.sendEncodablePostAndDispatch(.integrationsTelegramConfig, body: msg, method: "GET", messageType: "telegram_config_response", label: "telegram_config_get") }
                case "clear":
                    Task { await self.sendEncodablePostAndDispatch(.integrationsTelegramConfig, body: msg, method: "DELETE", messageType: "telegram_config_response", label: "telegram_config_clear") }
                default:
                    // "set" and any future actions use POST
                    Task { await self.sendEncodablePostAndDispatch(.integrationsTelegramConfig, body: msg, messageType: "telegram_config_response", label: "telegram_config_set") }
                }
                return true
            }
            if let msg = message as? ChannelVerificationSessionRequestMessage {
                switch msg.action {
                case "status":
                    let channel = msg.channel ?? "telegram"
                    Task { await self.sendVerificationStatusGetAndDispatch(channel: channel) }
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
            // --- Publishing ---
            if let msg = message as? PublishPageRequestMessage {
                Task { await self.sendEncodablePost(.publishPage, body: msg, label: "publish_page") }
                return true
            }
            if let msg = message as? UnpublishPageRequestMessage {
                Task { await self.sendEncodablePost(.unpublishPage, body: msg, label: "unpublish_page") }
                return true
            }

            // --- Link Open ---
            if let msg = message as? LinkOpenRequestMessage {
                Task { await self.sendEncodablePost(.linkOpen, body: msg, label: "link_open_request") }
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

    // MARK: - Diagnostics Export

    /// Send a diagnostics export request and route the response through the message router.
    func sendDiagnosticsExport(_ msg: DiagnosticsExportRequestMessage) async {
        guard let url = buildURL(for: .diagnosticsExport) else {
            log.error("Failed to build URL for diagnostics_export")
            self.onMessage?(.diagnosticsExportResponse(DiagnosticsExportResponseMessage(
                success: false,
                filePath: nil,
                error: "Failed to build URL"
            )))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(msg)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                log.error("diagnostics_export failed: no HTTP response")
                self.onMessage?(.diagnosticsExportResponse(DiagnosticsExportResponseMessage(
                    success: false,
                    filePath: nil,
                    error: "No HTTP response"
                )))
                return
            }

            if (200...299).contains(http.statusCode) {
                // Parse successful response
                let responseMessage = try JSONDecoder().decode(DiagnosticsExportResponseMessage.self, from: data)
                log.debug("diagnostics_export succeeded")
                self.onMessage?(.diagnosticsExportResponse(responseMessage))
            } else {
                // Try to parse error message from response
                var errorMessage = "HTTP \(http.statusCode)"
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let error = json["error"] as? [String: Any],
                   let message = error["message"] as? String {
                    errorMessage = message
                }
                log.error("diagnostics_export failed: \(errorMessage)")
                self.onMessage?(.diagnosticsExportResponse(DiagnosticsExportResponseMessage(
                    success: false,
                    filePath: nil,
                    error: errorMessage
                )))
            }
        } catch {
            log.error("diagnostics_export error: \(error.localizedDescription)")
            self.onMessage?(.diagnosticsExportResponse(DiagnosticsExportResponseMessage(
                success: false,
                filePath: nil,
                error: error.localizedDescription
            )))
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
        guard let url = buildURL(for: endpoint) else {
            log.error("Failed to build URL for \(label)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(body)
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
        guard let url = buildURL(for: endpoint) else {
            log.error("Failed to build URL for \(label)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(body)
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

    /// Fetch channel verification status via GET with a channel query parameter,
    /// then dispatch the response through the message handler chain.
    private func sendVerificationStatusGetAndDispatch(channel: String) async {
        guard var url = buildURL(for: .channelVerificationSessionsStatus) else {
            log.error("Failed to build URL for channel_verification_status")
            return
        }
        // Append the channel query parameter
        if var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            var items = components.queryItems ?? []
            items.append(URLQueryItem(name: "channel", value: channel))
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
                log.error("channel_verification_status failed: \(http.statusCode)")
                var errorMessage = "HTTP \(http.statusCode)"
                if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let error = json["error"] as? [String: Any],
                   let message = error["message"] as? String {
                    errorMessage = message
                } else if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let message = json["error"] as? String {
                    errorMessage = message
                }
                dispatchSyntheticError(messageType: "channel_verification_session_response", errorMessage: errorMessage, channel: channel)
                return
            }

            guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                log.error("channel_verification_status: failed to parse response JSON")
                return
            }
            json["type"] = "channel_verification_session_response"
            let enriched = try JSONSerialization.data(withJSONObject: json)
            let serverMessage = try decoder.decode(ServerMessage.self, from: enriched)
            onMessage?(serverMessage)
        } catch {
            log.error("channel_verification_status error: \(error.localizedDescription)")
            dispatchSyntheticError(messageType: "channel_verification_session_response", errorMessage: error.localizedDescription, channel: channel)
        }
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
