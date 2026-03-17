import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Work Items Domain Dispatcher

extension HTTPTransport {

    func registerWorkItemsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? WorkItemPreflightRequest {
                Task { await self.handleWorkItemPreflight(id: msg.id) }
                return true
            } else if let msg = message as? WorkItemApprovePermissionsRequest {
                Task { await self.handleWorkItemApprovePermissions(id: msg.id, approvedTools: msg.approvedTools) }
                return true
            } else if let msg = message as? WorkItemCancelRequest {
                Task { await self.handleWorkItemCancel(id: msg.id) }
                return true
            }

            return false
        }
    }

    // MARK: - Work Items HTTP Endpoints

    private func handleWorkItemPreflight(id: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemPreflight(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleWorkItemPreflight(id: id, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Work item preflight failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemPreflightResponse.self, from: data)
            onMessage?(.workItemPreflightResponse(decoded))
        } catch {
            log.error("Work item preflight error: \(error.localizedDescription)")
        }
    }

    private func handleWorkItemApprovePermissions(id: String, approvedTools: [String], isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemApprovePermissions(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        let body: [String: Any] = ["approvedTools": approvedTools]

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleWorkItemApprovePermissions(id: id, approvedTools: approvedTools, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Work item approve permissions failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemApprovePermissionsResponse.self, from: data)
            onMessage?(.workItemApprovePermissionsResponse(decoded))
        } catch {
            log.error("Work item approve permissions error: \(error.localizedDescription)")
        }
    }

    private func handleWorkItemCancel(id: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemCancel(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleWorkItemCancel(id: id, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Work item cancel failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemCancelResponse.self, from: data)
            onMessage?(.workItemCancelResponse(decoded))
        } catch {
            log.error("Work item cancel error: \(error.localizedDescription)")
        }
    }
}

/// Local error envelope for decoding HTTP error responses in work items dispatch.
private struct HTTPErrorEnvelopeLocal: Decodable {
    struct ErrorBody: Decodable {
        let message: String
    }
    let error: ErrorBody
}
