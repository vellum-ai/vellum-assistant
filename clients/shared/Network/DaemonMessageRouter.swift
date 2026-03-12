import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "DaemonClient")

// MARK: - Message Routing

extension DaemonClient {

    func handleServerMessage(_ message: ServerMessage) {
        // Handle daemon status internally.
        if case .daemonStatus(let status) = message {
            httpPort = status.httpPort.flatMap { Int(exactly: $0) }
            if let version = status.version {
                daemonVersion = version
            }
            if let newFingerprint = status.keyFingerprint {
                let oldFingerprint = keyFingerprint
                keyFingerprint = newFingerprint

                if let oldFingerprint, oldFingerprint != newFingerprint {
                    // Instance changed mid-connection
                    log.info("Daemon key fingerprint changed (\(oldFingerprint, privacy: .public) → \(newFingerprint, privacy: .public)) — invalidating credentials")
                    ActorTokenManager.deleteAllCredentials()
                    NotificationCenter.default.post(name: .daemonInstanceChanged, object: nil)
                } else if oldFingerprint == nil, ActorTokenManager.hasToken {
                    // First daemon_status with a fingerprint, but we already have a stored token.
                    // The reactive 401 retry (executeLocalRequest) handles re-bootstrap if the
                    // token is stale. No proactive action needed here.
                }
            }
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
        case .hostBashRequest(let msg):
            onHostBashRequest?(msg)
            handleHostBashRequest(msg)
        case .hostFileRequest(let msg):
            onHostFileRequest?(msg)
            handleHostFileRequest(msg)
        case .hostCuRequest(let msg):
            handleHostCuRequest(msg)
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
        // Integration stub responses — server-side handlers are no-ops; ignore.
        case .integrationListResponse, .integrationConnectResult:
            break
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

    /// Handle auth_result messages. With HTTP transport, authentication is
    /// handled via bearer tokens at the HTTP level. This handler updates
    /// the local authentication state for backward compatibility with
    /// daemon broadcasts.
    func handleAuthResult(_ result: AuthResultMessage) {
        isAuthenticated = result.success
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
    func handleGetSigningIdentity(_ msg: GetSigningIdentityRequest) {
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

    // MARK: - Host File Proxy

    /// Handle a host_file_request by executing the file operation locally
    /// and posting the result back to the daemon.
    func handleHostFileRequest(_ msg: HostFileRequest) {
        #if os(macOS)
        httpTransport?.executeHostFileRequest(msg)
        #else
        log.warning("Received host_file_request on iOS — local file operations not supported")
        Task {
            let result = HostFileResultPayload(
                requestId: msg.requestId,
                content: "Host file operations are not supported on iOS",
                isError: true
            )
            await httpTransport?.postHostFileResult(result)
        }
        #endif
    }

    // MARK: - Host Bash Proxy

    /// Handle a host_bash_request by executing the command locally via
    /// `Foundation.Process` and posting the result back to the daemon.
    func handleHostBashRequest(_ msg: HostBashRequest) {
        #if os(macOS)
        httpTransport?.executeHostBashRequest(msg)
        #else
        log.warning("Received host_bash_request on iOS — local execution not supported")
        // Post an error result back so the daemon doesn't hang waiting
        Task {
            let result = HostBashResultPayload(
                requestId: msg.requestId,
                stdout: "",
                stderr: "Host bash execution is not supported on iOS",
                exitCode: nil,
                timedOut: false
            )
            await httpTransport?.postHostBashResult(result)
        }
        #endif
    }

    // MARK: - Host CU Proxy

    /// Handle a host_cu_request by delegating to the registered `onHostCuRequest`
    /// callback (set by the macOS app to run verify -> execute -> observe) or
    /// posting an error on unsupported platforms.
    ///
    /// Unlike host bash/file which use Foundation-only APIs (available in the
    /// shared module), CU execution depends on macOS-only types from the app
    /// target (ActionExecutor, AccessibilityTree, etc.). The macOS app registers
    /// a callback via `onHostCuRequest` to handle execution; on iOS we post a
    /// not-supported error directly.
    func handleHostCuRequest(_ msg: HostCuRequest) {
        if let handler = onHostCuRequest {
            handler(msg)
        } else {
            // No handler registered — post error so the daemon doesn't hang
            #if os(iOS)
            log.warning("Received host_cu_request on iOS — computer use not supported")
            #else
            log.error("Received host_cu_request but no handler registered")
            #endif
            Task {
                let result = HostCuResultPayload(
                    requestId: msg.requestId,
                    axTree: nil,
                    axDiff: nil,
                    screenshot: nil,
                    screenshotWidthPx: nil,
                    screenshotHeightPx: nil,
                    screenWidthPt: nil,
                    screenHeightPt: nil,
                    executionResult: nil,
                    executionError: "Computer use is not supported on this platform",
                    secondaryWindows: nil,
                    userGuidance: nil
                )
                await httpTransport?.postHostCuResult(result)
            }
        }
    }
}
