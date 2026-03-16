import AppKit
import AVFoundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+Recording")

extension AppDelegate {

    /// Handle a `recording_start` message from the daemon.
    ///
    /// Checks screen recording permission, optionally shows the source picker,
    /// and starts recording via the RecordingManager.
    func handleRecordingStart(_ msg: RecordingStart) {
        // Check screen recording permission
        let permissionStatus = PermissionManager.screenRecordingStatus()
        guard permissionStatus == .granted else {
            log.warning("Screen recording permission denied — showing guidance")
            PermissionManager.requestScreenRecordingAccess()

            // Notify daemon that recording failed due to permission
            let statusMsg = RecordingStatus(
                type: "recording_status",
                conversationId: msg.recordingId,
                status: "failed",
                error: "Screen recording permission is required. Please grant access in System Settings > Privacy & Security > Screen Recording, then try again.",
                operationToken: msg.operationToken
            )
            try? daemonClient.send(statusMsg)
            return
        }

        let options = msg.options

        // If promptForSource is true, show the source picker
        if options?.promptForSource == true {
            showRecordingSourcePicker(
                recordingId: msg.recordingId,
                attachToConversationId: msg.attachToConversationId,
                operationToken: msg.operationToken
            )
            return
        }

        // Start recording directly with provided options
        startRecording(
            recordingId: msg.recordingId,
            options: options,
            attachToConversationId: msg.attachToConversationId,
            operationToken: msg.operationToken
        )
    }

    /// Handle a `recording_pause` message from the daemon.
    func handleRecordingPause(_ msg: RecordingPause) {
        let paused = recordingManager.pause(sessionId: msg.recordingId)
        if paused {
            recordingHUDWindow?.setPaused(true)
        }
    }

    /// Handle a `recording_resume` message from the daemon.
    func handleRecordingResume(_ msg: RecordingResume) {
        let resumed = recordingManager.resume(sessionId: msg.recordingId)
        if resumed {
            recordingHUDWindow?.setPaused(false)
        }
    }

    /// Show the recording source picker, then start recording with the selected options.
    ///
    /// When `operationToken` is set (restart flow), dismissing the picker without
    /// selecting a source sends a `restart_cancelled` status to the daemon.
    private func showRecordingSourcePicker(
        recordingId: String,
        attachToConversationId: String?,
        operationToken: String? = nil
    ) {
        if recordingPickerWindow == nil {
            recordingPickerWindow = RecordingSourcePickerWindow()
        }

        recordingPickerWindow?.show(
            onStart: { [weak self] selectedOptions in
                self?.startRecording(
                    recordingId: recordingId,
                    options: selectedOptions,
                    attachToConversationId: attachToConversationId,
                    promptForSource: true,
                    operationToken: operationToken
                )
            },
            onCancel: { [weak self] in
                if operationToken != nil {
                    // Restart flow: picker dismissed without selection —
                    // send restart_cancelled so the daemon knows to abort.
                    let statusMsg = RecordingStatus(
                        type: "recording_status",
                        conversationId: recordingId,
                        status: "restart_cancelled",
                        attachToConversationId: attachToConversationId,
                        operationToken: operationToken
                    )
                    try? self?.daemonClient.send(statusMsg)
                    log.info("Restart cancelled — source picker dismissed for session \(recordingId, privacy: .public)")
                } else {
                    // Normal start flow: picker cancelled
                    let statusMsg = RecordingStatus(
                        type: "recording_status",
                        conversationId: recordingId,
                        status: "failed",
                        error: "Recording cancelled by user"
                    )
                    try? self?.daemonClient.send(statusMsg)
                }
            }
        )
    }

    /// Start recording and show the recording HUD only after recording is confirmed.
    private func startRecording(
        recordingId: String,
        options: RecordingOptions?,
        attachToConversationId: String?,
        promptForSource: Bool = false,
        operationToken: String? = nil
    ) {
        // Wire up re-prompt callback so RecordingManager can re-show the
        // source picker when the selected source is no longer available.
        recordingManager.onSourceValidationFailed = { [weak self] sessionId, conversationId in
            self?.showRecordingSourcePicker(
                recordingId: sessionId,
                attachToConversationId: conversationId,
                operationToken: operationToken
            )
        }

        Task {
            // Check microphone permission if requested; disable mic if denied
            // so the recording starts without mic rather than failing.
            var micAllowed = options?.includeMicrophone ?? false
            if micAllowed {
                let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
                if micStatus == .notDetermined {
                    let granted = await AVCaptureDevice.requestAccess(for: .audio)
                    if !granted {
                        log.warning("Microphone permission denied — recording without microphone")
                        micAllowed = false
                    }
                } else if micStatus == .denied || micStatus == .restricted {
                    log.warning("Microphone permission denied — recording without microphone")
                    micAllowed = false
                }
            }
            // Rebuild options with the resolved mic permission
            let effectiveOptions = RecordingOptions(
                captureScope: options?.captureScope,
                displayId: options?.displayId,
                windowId: options?.windowId,
                includeAudio: options?.includeAudio,
                includeMicrophone: micAllowed,
                promptForSource: options?.promptForSource
            )

            let started = await recordingManager.start(
                sessionId: recordingId,
                options: effectiveOptions,
                attachToConversationId: attachToConversationId,
                promptForSource: promptForSource,
                operationToken: operationToken
            )

            guard started else { return }

            // Show the recording HUD only after recording is confirmed
            if recordingHUDWindow == nil {
                recordingHUDWindow = RecordingHUDWindow()
            }

            recordingHUDWindow?.show(
                onStop: { [weak self] in
                    guard let self else { return }
                    Task {
                        _ = await self.recordingManager.stop(sessionId: recordingId)
                        self.recordingHUDWindow?.dismiss()
                    }
                },
                onPauseResume: { [weak self] requestPause in
                    guard let self else { return }
                    if requestPause {
                        let paused = self.recordingManager.pause(sessionId: recordingId)
                        if paused {
                            self.recordingHUDWindow?.setPaused(true)
                        }
                    } else {
                        let resumed = self.recordingManager.resume(sessionId: recordingId)
                        if resumed {
                            self.recordingHUDWindow?.setPaused(false)
                        }
                    }
                }
            )
        }
    }
}
