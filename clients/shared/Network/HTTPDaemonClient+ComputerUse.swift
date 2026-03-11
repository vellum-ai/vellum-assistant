import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Computer Use & Recording HTTP Dispatchers

/// Registers domain dispatchers for computer use sessions, ride-shotgun,
/// watch observations, and recording lifecycle messages.
extension HTTPTransport {

    func registerComputerUseRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            // --- CU Session Create ---
            if let msg = message as? CuSessionCreateMessage {
                Task { await self.sendCuSessionCreate(msg) }
                return true
            }

            // --- CU Session Abort ---
            if let msg = message as? CuSessionAbortMessage {
                Task { await self.sendCuSessionAbort(msg) }
                return true
            }

            // --- CU Observation ---
            if let msg = message as? CuObservationMessage {
                Task { await self.sendCuObservation(msg) }
                return true
            }

            // --- Task Submit ---
            if let msg = message as? TaskSubmitMessage {
                Task { await self.sendTaskSubmit(msg) }
                return true
            }

            // --- Ride Shotgun Start ---
            if let msg = message as? RideShotgunStartMessage {
                Task { await self.sendRideShotgunStart(msg) }
                return true
            }

            // --- Ride Shotgun Stop ---
            if let msg = message as? RideShotgunStopMessage {
                Task { await self.sendRideShotgunStop(msg) }
                return true
            }

            // --- Watch Observation ---
            if let msg = message as? WatchObservationMessage {
                Task { await self.sendWatchObservation(msg) }
                return true
            }

            // --- Recording Status (client → server lifecycle update) ---
            if let msg = message as? RecordingStatus {
                Task { await self.sendRecordingStatus(msg) }
                return true
            }

            return false
        }
    }

    // MARK: - Computer Use Endpoints

    private func sendCuSessionCreate(_ msg: CuSessionCreateMessage) async {
        guard let url = buildURL(for: .cuSessionCreate) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "sessionId": msg.sessionId,
            "task": msg.task,
            "screenWidth": msg.screenWidth,
            "screenHeight": msg.screenHeight,
        ]
        if let interactionType = msg.interactionType {
            body["interactionType"] = interactionType
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 201 || http.statusCode == 200 {
                log.info("CU session created via HTTP")
            } else {
                log.error("CU session create failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("CU session create error: \(error.localizedDescription)")
        }
    }

    private func sendCuSessionAbort(_ msg: CuSessionAbortMessage) async {
        guard let url = buildURL(for: .cuSessionAbort(sessionId: msg.sessionId)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                log.info("CU session aborted via HTTP")
            } else {
                log.error("CU session abort failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("CU session abort error: \(error.localizedDescription)")
        }
    }

    private func sendCuObservation(_ msg: CuObservationMessage) async {
        guard let url = buildURL(for: .cuObservation) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(msg)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                log.debug("CU observation sent via HTTP")
            } else {
                log.error("CU observation failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("CU observation error: \(error.localizedDescription)")
        }
    }

    private func sendTaskSubmit(_ msg: TaskSubmitMessage) async {
        guard let url = buildURL(for: .cuTaskSubmit) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "task": msg.task,
            "screenWidth": msg.screenWidth,
            "screenHeight": msg.screenHeight,
        ]
        if let source = msg.source {
            body["source"] = source
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 201 || http.statusCode == 200 {
                log.info("Task submitted via HTTP")
            } else {
                log.error("Task submit failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("Task submit error: \(error.localizedDescription)")
        }
    }

    private func sendRideShotgunStart(_ msg: RideShotgunStartMessage) async {
        guard let url = buildURL(for: .rideShotgunStart) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [
            "durationSeconds": msg.durationSeconds,
            "intervalSeconds": msg.intervalSeconds,
        ]
        if let mode = msg.mode {
            body["mode"] = mode
        }
        if let targetDomain = msg.targetDomain {
            body["targetDomain"] = targetDomain
        }
        if let navigateDomain = msg.navigateDomain {
            body["navigateDomain"] = navigateDomain
        }
        if let autoNavigate = msg.autoNavigate {
            body["autoNavigate"] = autoNavigate
        }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 201 || http.statusCode == 200 {
                log.info("Ride shotgun started via HTTP")
            } else {
                log.error("Ride shotgun start failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("Ride shotgun start error: \(error.localizedDescription)")
        }
    }

    private func sendRideShotgunStop(_ msg: RideShotgunStopMessage) async {
        guard let url = buildURL(for: .rideShotgunStop) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["watchId": msg.watchId]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                log.info("Ride shotgun stopped via HTTP")
            } else {
                log.error("Ride shotgun stop failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("Ride shotgun stop error: \(error.localizedDescription)")
        }
    }

    private func sendWatchObservation(_ msg: WatchObservationMessage) async {
        guard let url = buildURL(for: .cuWatch) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(msg)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                log.debug("Watch observation sent via HTTP")
            } else {
                log.error("Watch observation failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("Watch observation error: \(error.localizedDescription)")
        }
    }

    // MARK: - Recording Endpoints

    private func sendRecordingStatus(_ msg: RecordingStatus) async {
        guard let url = buildURL(for: .recordingStatus) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(msg)
            let (_, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                log.info("Recording status sent via HTTP")
            } else {
                log.error("Recording status failed: \((response as? HTTPURLResponse)?.statusCode ?? -1)")
            }
        } catch {
            log.error("Recording status error: \(error.localizedDescription)")
        }
    }
}
