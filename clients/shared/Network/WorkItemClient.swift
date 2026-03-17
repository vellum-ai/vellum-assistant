import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "WorkItemClient")

/// Focused client for work-item (task queue) operations routed through the gateway.
///
/// Covers listing, completing, deleting, running, fetching output, and updating
/// work items.
@MainActor
public protocol WorkItemClientProtocol {
    func fetchList(status: String?) async -> WorkItemsListResponse?
    func complete(id: String) async -> Bool
    func delete(id: String) async -> WorkItemDeleteResponse?
    func runTask(id: String) async -> WorkItemRunTaskResponse?
    func fetchOutput(id: String) async -> WorkItemOutputResponse?
    func update(id: String, title: String?, notes: String?, status: String?, priorityTier: Double?, sortIndex: Int?) async -> WorkItemUpdateResponse?
    func preflight(id: String) async -> WorkItemPreflightResponse?
    func approvePermissions(id: String, approvedTools: [String]) async -> WorkItemApprovePermissionsResponse?
    func cancel(id: String) async -> WorkItemCancelResponse?
}

/// Gateway-backed implementation of ``WorkItemClientProtocol``.
@MainActor
public struct WorkItemClient: WorkItemClientProtocol {
    nonisolated public init() {}

    public func fetchList(status: String? = nil) async -> WorkItemsListResponse? {
        do {
            var params: [String: String] = [:]
            if let status { params["status"] = status }

            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/work-items",
                params: params.isEmpty ? nil : params,
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchList failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_items_list_response", into: response.data)
            return try JSONDecoder().decode(WorkItemsListResponse.self, from: patched)
        } catch {
            log.error("fetchList error: \(error.localizedDescription)")
            return nil
        }
    }

    public func complete(id: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/work-items/\(id)/complete", timeout: 10
            )
            guard response.isSuccess else {
                log.error("complete failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("complete error: \(error.localizedDescription)")
            return false
        }
    }

    public func delete(id: String) async -> WorkItemDeleteResponse? {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/work-items/\(id)", timeout: 10
            )
            guard response.isSuccess else {
                log.error("delete failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_delete_response", into: response.data)
            return try JSONDecoder().decode(WorkItemDeleteResponse.self, from: patched)
        } catch {
            log.error("delete error: \(error.localizedDescription)")
            return nil
        }
    }

    public func runTask(id: String) async -> WorkItemRunTaskResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/work-items/\(id)/run", timeout: 10
            )
            guard response.isSuccess else {
                log.error("runTask failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_run_task_response", into: response.data)
            return try JSONDecoder().decode(WorkItemRunTaskResponse.self, from: patched)
        } catch {
            log.error("runTask error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchOutput(id: String) async -> WorkItemOutputResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/work-items/\(id)/output", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchOutput failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_output_response", into: response.data)
            return try JSONDecoder().decode(WorkItemOutputResponse.self, from: patched)
        } catch {
            log.error("fetchOutput error: \(error.localizedDescription)")
            return nil
        }
    }

    public func update(id: String, title: String? = nil, notes: String? = nil, status: String? = nil, priorityTier: Double? = nil, sortIndex: Int? = nil) async -> WorkItemUpdateResponse? {
        do {
            var body: [String: Any] = [:]
            if let title { body["title"] = title }
            if let notes { body["notes"] = notes }
            if let status { body["status"] = status }
            if let priorityTier { body["priorityTier"] = priorityTier }
            if let sortIndex { body["sortIndex"] = sortIndex }

            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/work-items/\(id)", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("update failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_update_response", into: response.data)
            return try JSONDecoder().decode(WorkItemUpdateResponse.self, from: patched)
        } catch {
            log.error("update error: \(error.localizedDescription)")
            return nil
        }
    }

    public func preflight(id: String) async -> WorkItemPreflightResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/work-items/\(id)/preflight", timeout: 10
            )
            guard response.isSuccess else {
                log.error("preflight failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_preflight_response", into: response.data)
            return try JSONDecoder().decode(WorkItemPreflightResponse.self, from: patched)
        } catch {
            log.error("preflight error: \(error.localizedDescription)")
            return nil
        }
    }

    public func approvePermissions(id: String, approvedTools: [String]) async -> WorkItemApprovePermissionsResponse? {
        do {
            let body: [String: Any] = ["approvedTools": approvedTools]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/work-items/\(id)/approve-permissions", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("approvePermissions failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_approve_permissions_response", into: response.data)
            return try JSONDecoder().decode(WorkItemApprovePermissionsResponse.self, from: patched)
        } catch {
            log.error("approvePermissions error: \(error.localizedDescription)")
            return nil
        }
    }

    public func cancel(id: String) async -> WorkItemCancelResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/work-items/\(id)/cancel", timeout: 10
            )
            guard response.isSuccess else {
                log.error("cancel failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("work_item_cancel_response", into: response.data)
            return try JSONDecoder().decode(WorkItemCancelResponse.self, from: patched)
        } catch {
            log.error("cancel error: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Helpers

    /// Injects the `"type"` discriminant required by `Codable` decoding of
    /// server message types whose JSON payloads omit it over HTTP.
    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
