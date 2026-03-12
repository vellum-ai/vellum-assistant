import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Watch & Recording HTTP Dispatchers

/// Registers domain dispatchers for watch observations and recording lifecycle messages.
extension HTTPTransport {

    func registerComputerUseRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

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

    // MARK: - Watch Endpoints

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
