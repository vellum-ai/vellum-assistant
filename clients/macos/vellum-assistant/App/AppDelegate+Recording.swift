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
    func handleRecordingStart(_ msg: IPCRecordingStart) {
        // Check screen recording permission
        let permissionStatus = PermissionManager.screenRecordingStatus()
        guard permissionStatus == .granted else {
            log.warning("Screen recording permission denied — showing guidance")
            PermissionManager.requestScreenRecordingAccess()

            // Notify daemon that recording failed due to permission
            let statusMsg = IPCRecordingStatus(
                type: "recording_status",
                sessionId: msg.recordingId,
                status: "failed",
                error: "Screen recording permission is required. Please grant access in System Settings > Privacy & Security > Screen Recording, then try again."
            )
            try? daemonClient.send(statusMsg)
            return
        }

        let options = msg.options

        // If promptForSource is true, show the source picker
        if options?.promptForSource == true {
            showRecordingSourcePicker(
                recordingId: msg.recordingId,
                attachToConversationId: msg.attachToConversationId
            )
            return
        }

        // Start recording directly with provided options
        startRecording(
            recordingId: msg.recordingId,
            options: options,
            attachToConversationId: msg.attachToConversationId
        )
    }

    /// Show the recording source picker, then start recording with the selected options.
    private func showRecordingSourcePicker(recordingId: String, attachToConversationId: String?) {
        if recordingPickerWindow == nil {
            recordingPickerWindow = RecordingSourcePickerWindow()
        }

        recordingPickerWindow?.show(
            onStart: { [weak self] selectedOptions in
                self?.startRecording(
                    recordingId: recordingId,
                    options: selectedOptions,
                    attachToConversationId: attachToConversationId
                )
            },
            onCancel: { [weak self] in
                // Notify daemon that recording was cancelled
                let statusMsg = IPCRecordingStatus(
                    type: "recording_status",
                    sessionId: recordingId,
                    status: "failed",
                    error: "Recording cancelled by user"
                )
                try? self?.daemonClient.send(statusMsg)
            }
        )
    }

    /// Start recording and show the recording HUD only after recording is confirmed.
    private func startRecording(
        recordingId: String,
        options: IPCRecordingOptions?,
        attachToConversationId: String?
    ) {
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
            let effectiveOptions = IPCRecordingOptions(
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
                attachToConversationId: attachToConversationId
            )

            guard started else { return }

            // Show the recording HUD only after recording is confirmed
            if recordingHUDWindow == nil {
                recordingHUDWindow = RecordingHUDWindow()
            }

            recordingHUDWindow?.show(onStop: { [weak self] in
                guard let self else { return }
                Task {
                    _ = await self.recordingManager.stop(sessionId: recordingId)
                    self.recordingHUDWindow?.dismiss()
                }
            })
        }
    }
}
