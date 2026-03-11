import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Work Items Domain Dispatcher

extension HTTPTransport {

    func registerWorkItemsRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if let msg = message as? WorkItemsListRequest {
                Task { await self.fetchWorkItemsList(status: msg.status) }
                return true
            } else if let msg = message as? WorkItemCompleteRequest {
                Task { await self.handleWorkItemComplete(id: msg.id) }
                return true
            } else if let msg = message as? WorkItemDeleteRequest {
                Task { await self.handleWorkItemDelete(id: msg.id) }
                return true
            } else if let msg = message as? WorkItemRunTaskRequest {
                Task { await self.handleWorkItemRunTask(id: msg.id) }
                return true
            } else if let msg = message as? WorkItemOutputRequest {
                Task { await self.fetchWorkItemOutput(id: msg.id) }
                return true
            } else if let msg = message as? WorkItemUpdateRequest {
                Task {
                    await self.handleWorkItemUpdate(
                        id: msg.id,
                        title: msg.title,
                        notes: msg.notes,
                        status: msg.status,
                        priorityTier: msg.priorityTier,
                        sortIndex: msg.sortIndex
                    )
                }
                return true
            } else if let msg = message as? WorkItemPreflightRequest {
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

    private func fetchWorkItemsList(status: String?, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemsList) else { return }

        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let status {
            var queryItems = components?.queryItems ?? []
            queryItems.append(URLQueryItem(name: "status", value: status))
            components?.queryItems = queryItems
        }
        guard let finalURL = components?.url ?? url as URL? else { return }

        var request = URLRequest(url: finalURL)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchWorkItemsList(status: status, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch work items list failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemsListResponse.self, from: data)
            onMessage?(.workItemsListResponse(decoded))
        } catch {
            log.error("Fetch work items list error: \(error.localizedDescription)")
        }
    }

    private func handleWorkItemComplete(id: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemComplete(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleWorkItemComplete(id: id, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Work item complete failed (\(http.statusCode))")
                    return
                }
            }

            // The complete endpoint returns the updated item; emit a status changed event
            log.info("Work item complete request sent for \(id)")
        } catch {
            log.error("Work item complete error: \(error.localizedDescription)")
        }
    }

    private func handleWorkItemDelete(id: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemDelete(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleWorkItemDelete(id: id, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Work item delete failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemDeleteResponse.self, from: data)
            onMessage?(.workItemDeleteResponse(decoded))
        } catch {
            log.error("Work item delete error: \(error.localizedDescription)")
        }
    }

    private func handleWorkItemRunTask(id: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemRun(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await handleWorkItemRunTask(id: id, isRetry: true) }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    let errorBody = String(data: data, encoding: .utf8) ?? "unknown"
                    log.error("Work item run task failed (\(http.statusCode)): \(errorBody)")
                    // Decode error to emit a response with error info
                    let errorMsg = (try? JSONDecoder().decode(HTTPErrorEnvelopeLocal.self, from: data))?.error.message ?? "HTTP \(http.statusCode)"
                    onMessage?(.workItemRunTaskResponse(WorkItemRunTaskResponse(
                        type: "work_item_run_task_response",
                        id: id,
                        lastRunId: "",
                        success: false,
                        error: errorMsg,
                        errorCode: http.statusCode == 403 ? "permissions_required" : nil
                    )))
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemRunTaskResponse.self, from: data)
            onMessage?(.workItemRunTaskResponse(decoded))
        } catch {
            log.error("Work item run task error: \(error.localizedDescription)")
            onMessage?(.workItemRunTaskResponse(WorkItemRunTaskResponse(
                type: "work_item_run_task_response",
                id: id,
                lastRunId: "",
                success: false,
                error: error.localizedDescription
            )))
        }
    }

    private func fetchWorkItemOutput(id: String, isRetry: Bool = false) async {
        guard let url = buildURL(for: .workItemOutput(id: id)) else { return }

        var request = URLRequest(url: url)
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result { await fetchWorkItemOutput(id: id, isRetry: true) }
                    return
                }
                guard http.statusCode == 200 else {
                    log.error("Fetch work item output failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemOutputResponse.self, from: data)
            onMessage?(.workItemOutputResponse(decoded))
        } catch {
            log.error("Fetch work item output error: \(error.localizedDescription)")
        }
    }

    private func handleWorkItemUpdate(
        id: String,
        title: String?,
        notes: String?,
        status: String?,
        priorityTier: Double?,
        sortIndex: Int?,
        isRetry: Bool = false
    ) async {
        guard let url = buildURL(for: .workItemUpdate(id: id)) else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        var body: [String: Any] = [:]
        if let title { body["title"] = title }
        if let notes { body["notes"] = notes }
        if let status { body["status"] = status }
        if let priorityTier { body["priorityTier"] = priorityTier }
        if let sortIndex { body["sortIndex"] = sortIndex }

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let result = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = result {
                        await handleWorkItemUpdate(
                            id: id,
                            title: title,
                            notes: notes,
                            status: status,
                            priorityTier: priorityTier,
                            sortIndex: sortIndex,
                            isRetry: true
                        )
                    }
                    return
                }
                guard (200..<300).contains(http.statusCode) else {
                    log.error("Work item update failed (\(http.statusCode))")
                    return
                }
            }

            let decoded = try decoder.decode(WorkItemUpdateResponse.self, from: data)
            onMessage?(.workItemUpdateResponse(decoded))
        } catch {
            log.error("Work item update error: \(error.localizedDescription)")
        }
    }

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
