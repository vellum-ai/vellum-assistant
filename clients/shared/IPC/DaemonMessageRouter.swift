import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

// MARK: - Message Routing

extension DaemonClient {

    func handleServerMessage(_ message: ServerMessage) {
        // Handle pong internally.
        if case .pong = message {
            awaitingPong = false
            pongTimeoutTask?.cancel()
            pongTimeoutTask = nil
        }

        // Handle daemon status internally.
        if case .daemonStatus(let status) = message {
            httpPort = status.httpPort.flatMap { Int(exactly: $0) }
            if let version = status.version {
                daemonVersion = version
            }
        }

        // Handle blob probe result internally.
        if case .ipcBlobProbeResult(let result) = message {
            handleBlobProbeResult(result)
        }

        // Forward surface messages to registered callbacks.
        switch message {
        case .authResult(let msg):
            handleAuthResult(msg)
        case .uiSurfaceShow(let msg):
            // Inline surfaces are rendered in-chat by ChatViewModel; skip the floating panel.
            if msg.display != "inline" {
                onSurfaceShow?(msg)
            }
        case .uiSurfaceUpdate(let msg):
            onSurfaceUpdate?(msg)
        case .uiSurfaceDismiss(let msg):
            onSurfaceDismiss?(msg)
        case .uiSurfaceComplete(let msg):
            onSurfaceComplete?(msg)
        case .documentEditorShow(let msg):
            log.debug("documentEditorShow received — surfaceId=\(msg.surfaceId, privacy: .public), title=\(msg.title, privacy: .public)")
            onDocumentEditorShow?(msg)
            log.debug("documentEditorShow callback invoked")
        case .documentEditorUpdate(let msg):
            onDocumentEditorUpdate?(msg)
        case .documentSaveResponse(let msg):
            onDocumentSaveResponse?(msg)
        case .documentLoadResponse(let msg):
            onDocumentLoadResponse?(msg)
        case .documentListResponse(let msg):
            onDocumentListResponse?(msg)
        case .uiLayoutConfig(let msg):
            onLayoutConfig?(msg)
        case .appFilesChanged(let msg):
            onAppFilesChanged?(msg.appId)
        case .appDataResponse(let msg):
            onAppDataResponse?(msg)
        case .messageQueued(let msg):
            onMessageQueued?(msg)
        case .messageDequeued(let msg):
            onMessageDequeued?(msg)
        case .messageQueuedDeleted(let msg):
            onMessageQueuedDeleted?(msg)
        case .generationHandoff(let msg):
            onGenerationHandoff?(msg)
        case .confirmationRequest(let msg):
            onConfirmationRequest?(msg)
        case .confirmationStateChanged(let msg):
            onConfirmationStateChanged?(msg)
        case .assistantActivityState(let msg):
            onAssistantActivityState?(msg)
        case .secretRequest(let msg):
            onSecretRequest?(msg)
        case .taskRouted(let msg):
            onTaskRouted?(msg)
        case .dictationResponse(let msg):
            onDictationResponse?(msg)
        case .notificationIntent(let msg):
            onNotificationIntent?(msg)
        case .notificationThreadCreated(let msg):
            onNotificationThreadCreated?(msg)
        case .trustRulesListResponse(let msg):
            onTrustRulesListResponse?(msg.rules)
        case .toolPermissionSimulateResponse(let msg):
            onToolPermissionSimulateResponse?(msg)
        case .toolNamesListResponse(let msg):
            onToolNamesListResponse?(msg)
        case .schedulesListResponse(let msg):
            onSchedulesListResponse?(msg.schedules)
        case .remindersListResponse(let msg):
            onRemindersListResponse?(msg.reminders)
        case .skillStateChanged(let msg):
            onSkillStateChanged?(msg)
        case .skillsOperationResponse(let msg):
            onSkillsOperationResponse?(msg)
        case .skillsInspectResponse(let msg):
            onSkillsInspectResponse?(msg)
        case .skillsDraftResponse(let msg):
            onSkillsDraftResponse?(msg)
        case .appsListResponse(let msg):
            onAppsListResponse?(msg)
        case .homeBaseGetResponse(let msg):
            onHomeBaseGetResponse?(msg)
        case .appUpdatePreviewResponse:
            break // Fire-and-forget; no callback needed
        case .appPreviewResponse(let msg):
            onAppPreviewResponse?(msg)
        case .appHistoryResponse(let msg):
            onAppHistoryResponse?(msg)
        case .appDiffResponse(let msg):
            onAppDiffResponse?(msg)
        case .appFileAtVersionResponse:
            break // Handled by subscribers
        case .appRestoreResponse(let msg):
            onAppRestoreResponse?(msg)
        case .sharedAppsListResponse(let msg):
            onSharedAppsListResponse?(msg)
        case .appDeleteResponse(let msg):
            onAppDeleteResponse?(msg)
        case .sharedAppDeleteResponse(let msg):
            onSharedAppDeleteResponse?(msg)
        case .forkSharedAppResponse(let msg):
            onForkSharedAppResponse?(msg)
        case .bundleAppResponse(let msg):
            onBundleAppResponse?(msg)
        case .openBundleResponse(let msg):
            onOpenBundleResponse?(msg)
        case .sessionListResponse(let msg):
            onSessionListResponse?(msg)
        case .sessionTitleUpdated(let msg):
            onSessionTitleUpdated?(msg)
        case .historyResponse(let msg):
            onHistoryResponse?(msg)
        case .messageContentResponse(let msg):
            onMessageContentResponse?(msg)
        case .shareAppCloudResponse(let msg):
            onShareAppCloudResponse?(msg)
        case .slackWebhookConfigResponse(let msg):
            onSlackWebhookConfigResponse?(msg)
        case .ingressConfigResponse(let msg):
            onIngressConfigResponse?(msg)
        case .platformConfigResponse(let msg):
            onPlatformConfigResponse?(msg)
        case .vercelApiConfigResponse(let msg):
            onVercelApiConfigResponse?(msg)
        case .channelVerificationSessionResponse(let msg):
            onChannelVerificationSessionResponse?(msg)
        case .telegramConfigResponse(let msg):
            onTelegramConfigResponse?(msg)
        case .twitterIntegrationConfigResponse(let msg):
            onTwitterIntegrationConfigResponse?(msg)
        case .twitterAuthResult(let msg):
            onTwitterAuthResult?(msg)
        case .twitterAuthStatusResponse(let msg):
            onTwitterAuthStatusResponse?(msg)
        case .modelInfo(let msg):
            currentModel = msg.model
            onModelInfo?(msg)
        case .publishPageResponse(let msg):
            onPublishPageResponse?(msg)
        case .openUrl(let msg):
            onOpenUrl?(msg)
        case .navigateSettings(let msg):
            onNavigateSettings?(msg)
        case .unpublishPageResponse:
            break // Handled via specific callback if needed
        case .memoryStatus(let msg):
            latestMemoryStatus = msg
        case .traceEvent(let msg):
            onTraceEvent?(msg)
        case .error(let msg):
            onError?(msg)
        #if os(macOS)
        case .signBundlePayload(let msg):
            handleSignBundlePayload(msg)
        case .getSigningIdentity(let msg):
            handleGetSigningIdentity(msg)
        #elseif os(iOS)
        case .signBundlePayload(let msg):
            log.warning("Received sign_bundle_payload request on iOS — signing not supported")
            do {
                try send(SignBundlePayloadResponseMessage(
                    requestId: msg.requestId,
                    error: "Signing operations are not available on iOS"
                ))
            } catch {
                log.error("Failed to send SignBundlePayloadResponse: \(error)")
            }
        case .getSigningIdentity(let msg):
            log.warning("Received get_signing_identity request on iOS — signing not supported")
            do {
                try send(GetSigningIdentityResponseMessage(
                    requestId: msg.requestId,
                    error: "Signing operations are not available on iOS"
                ))
            } catch {
                log.error("Failed to send GetSigningIdentityResponse: \(error)")
            }
        #else
        case .signBundlePayload, .getSigningIdentity:
            log.error("Signing operations are not supported on this platform")
        #endif
        case .integrationListResponse(let msg):
            onIntegrationListResponse?(msg)
        case .integrationConnectResult(let msg):
            onIntegrationConnectResult?(msg)
        case .diagnosticsExportResponse(let msg):
            onDiagnosticsExportResponse?(msg)
        case .envVarsResponse(let msg):
            onEnvVarsResponse?(msg)
        case .workItemsListResponse(let msg):
            onWorkItemsListResponse?(msg)
        case .workItemStatusChanged(let msg):
            onWorkItemStatusChanged?(msg)
        case .tasksChanged(let msg):
            onTasksChanged?(msg)
        case .workItemDeleteResponse(let msg):
            onWorkItemDeleteResponse?(msg)
        case .workItemRunTaskResponse(let msg):
            onWorkItemRunTaskResponse?(msg)
        case .workItemOutputResponse(let msg):
            onWorkItemOutputResponse?(msg)
        case .workItemUpdateResponse(let msg):
            onWorkItemUpdateResponse?(msg)
        case .workItemPreflightResponse(let msg):
            onWorkItemPreflightResponse?(msg)
        case .workItemApprovePermissionsResponse(let msg):
            onWorkItemApprovePermissionsResponse?(msg)
        case .workItemCancelResponse(let msg):
            onWorkItemCancelResponse?(msg)
        case .taskRunThreadCreated(let msg):
            onTaskRunThreadCreated?(msg)
        case .scheduleThreadCreated(let msg):
            onScheduleThreadCreated?(msg)
        case .subagentSpawned(let msg):
            onSubagentSpawned?(msg)
        case .subagentStatusChanged(let msg):
            onSubagentStatusChanged?(msg)
        case .subagentDetailResponse(let msg):
            onSubagentDetailResponse?(msg)
        case .heartbeatConfigResponse(let msg):
            onHeartbeatConfigResponse?(msg)
        case .heartbeatRunsListResponse(let msg):
            onHeartbeatRunsListResponse?(msg)
        case .heartbeatRunNowResponse(let msg):
            onHeartbeatRunNowResponse?(msg)
        case .heartbeatChecklistResponse(let msg):
            onHeartbeatChecklistResponse?(msg)
        case .heartbeatChecklistWriteResponse(let msg):
            onHeartbeatChecklistWriteResponse?(msg)
        case .pairingApprovalRequest(let msg):
            onPairingApprovalRequest?(msg)
        case .approvedDevicesListResponse(let msg):
            onApprovedDevicesListResponse?(msg)
        case .approvedDeviceRemoveResponse(let msg):
            onApprovedDeviceRemoveResponse?(msg)
        case .recordingPause(let msg):
            onRecordingPause?(msg)
        case .recordingResume(let msg):
            onRecordingResume?(msg)
        case .recordingStart(let msg):
            onRecordingStart?(msg)
        case .recordingStop(let msg):
            onRecordingStop?(msg)
        case .clientSettingsUpdate(let msg):
            onClientSettingsUpdate?(msg)
        case .identityChanged(let msg):
            onIdentityChanged?(msg)
        case .avatarUpdated(let msg):
            onAvatarUpdated?(msg)
        case .generateAvatarResponse(let msg):
            onGenerateAvatarResponse?(msg)
        case .contactsResponse(let msg):
            onContactsResponse?(msg)
        case .contactsChanged(let msg):
            onContactsChanged?(msg)
        default:
            break
        }

        // Broadcast to all subscribers.
        for continuation in subscribers.values {
            continuation.yield(message)
        }
    }

    func handleAuthResult(_ result: AuthResultMessage) {
        #if os(macOS) || os(iOS)
        isAuthenticated = result.success
        if let pending = authContinuation {
            authContinuation = nil
            authTimeoutTask?.cancel()
            authTimeoutTask = nil
            if result.success {
                pending.resume(returning: ())
            } else {
                pending.resume(throwing: AuthError.rejected(result.message))
            }
        }
        #endif
    }

    // MARK: - Signing Identity (macOS only)

    #if os(macOS)
    /// Handle a sign_bundle_payload request from the daemon.
    func handleSignBundlePayload(_ msg: SignBundlePayloadMessage) {
        do {
            let payloadData = Data(msg.payload.utf8)
            let signature = try SigningIdentityManager.shared.sign(payloadData)
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            try send(SignBundlePayloadResponseMessage(
                requestId: msg.requestId,
                signature: signature.base64EncodedString(),
                keyId: keyId,
                publicKey: publicKey.rawRepresentation.base64EncodedString()
            ))
        } catch {
            log.error("Failed to sign bundle payload: \(error.localizedDescription)")
            do {
                try send(SignBundlePayloadResponseMessage(
                    requestId: msg.requestId,
                    error: error.localizedDescription
                ))
            } catch {
                log.error("Failed to send SignBundlePayloadResponse: \(error)")
            }
        }
    }

    /// Handle a get_signing_identity request from the daemon.
    func handleGetSigningIdentity(_ msg: IPCGetSigningIdentityRequest) {
        do {
            let keyId = try SigningIdentityManager.shared.getKeyId()
            let publicKey = try SigningIdentityManager.shared.getPublicKey()

            try send(GetSigningIdentityResponseMessage(
                requestId: msg.requestId,
                keyId: keyId,
                publicKey: publicKey.rawRepresentation.base64EncodedString()
            ))
        } catch {
            log.error("Failed to get signing identity: \(error.localizedDescription)")
            do {
                try send(GetSigningIdentityResponseMessage(
                    requestId: msg.requestId,
                    error: error.localizedDescription
                ))
            } catch {
                log.error("Failed to send GetSigningIdentityResponse: \(error)")
            }
        }
    }
    #endif
}
