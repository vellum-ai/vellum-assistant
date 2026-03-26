import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ContactClient")

/// Focused client for contact management operations routed through the gateway.
@MainActor
public protocol ContactClientProtocol {
    func updateContact(
        contactId: String,
        displayName: String,
        notes: String?
    ) async throws -> ContactPayload?

    func createContact(
        displayName: String,
        notes: String?,
        channels: [NewContactChannel]?
    ) async throws -> ContactPayload?

    func createInvite(
        sourceChannel: String,
        note: String?,
        maxUses: Int?,
        contactName: String?,
        contactId: String?,
        expectedExternalUserId: String?,
        friendName: String?,
        guardianName: String?
    ) async throws -> (inviteId: String, token: String?, shareUrl: String?, inviteCode: String?, voiceCode: String?, guardianInstruction: String?, channelHandle: String?)?

    func triggerInviteCall(inviteId: String) async throws -> Bool

    func fetchContactsList(limit: Int, role: String?) async throws -> [ContactPayload]
    func fetchContact(contactId: String) async throws -> ContactPayload?
    func deleteContact(contactId: String) async throws -> Bool
    func updateContactChannel(channelId: String, status: String?, policy: String?, reason: String?) async throws -> ContactPayload?
}

/// A channel to attach when creating a new contact.
public struct NewContactChannel: Codable {
    public let type: String
    public let address: String
    public let isPrimary: Bool

    public init(type: String, address: String, isPrimary: Bool = false) {
        self.type = type
        self.address = address
        self.isPrimary = isPrimary
    }
}

/// Gateway-backed implementation of ``ContactClientProtocol``.
@MainActor
public struct ContactClient: ContactClientProtocol {
    nonisolated public init() {}

    enum ContactClientError: LocalizedError {
        case httpError(statusCode: Int, serverMessage: String?)

        var errorDescription: String? {
            switch self {
            case .httpError(let statusCode, let serverMessage):
                if let serverMessage {
                    return "Contact request failed (HTTP \(statusCode)): \(serverMessage)"
                }
                return "Contact request failed (HTTP \(statusCode))"
            }
        }
    }

    /// Attempt to extract a human-readable error message from a non-2xx response body.
    private static func parseServerError(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["message"] as? String ?? json["error"] as? String
    }

    private struct UpsertResponse: Decodable {
        let ok: Bool
        let contact: ContactPayload
    }

    private struct CreateInviteResponse: Decodable {
        let ok: Bool
        let invite: InviteData?
        struct InviteData: Decodable {
            let id: String
            let token: String?
            let share: ShareData?
            let inviteCode: String?
            let voiceCode: String?
            let guardianInstruction: String?
            let channelHandle: String?
        }
        struct ShareData: Decodable {
            let url: String
            let displayText: String
        }
    }

    public func updateContact(
        contactId: String,
        displayName: String,
        notes: String? = nil
    ) async throws -> ContactPayload? {
        var body: [String: Any] = ["id": contactId, "displayName": displayName]
        if let notes { body["notes"] = notes }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/contacts", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("updateContact failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return try JSONDecoder().decode(UpsertResponse.self, from: response.data).contact
    }

    public func createContact(
        displayName: String,
        notes: String? = nil,
        channels: [NewContactChannel]? = nil
    ) async throws -> ContactPayload? {
        var body: [String: Any] = ["displayName": displayName]
        if let notes { body["notes"] = notes }
        if let channels {
            body["channels"] = channels.map { ch -> [String: Any] in
                ["type": ch.type, "address": ch.address, "isPrimary": ch.isPrimary]
            }
        }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/contacts", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("createContact failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return try JSONDecoder().decode(UpsertResponse.self, from: response.data).contact
    }

    public func createInvite(
        sourceChannel: String,
        note: String? = nil,
        maxUses: Int? = nil,
        contactName: String? = nil,
        contactId: String? = nil,
        expectedExternalUserId: String? = nil,
        friendName: String? = nil,
        guardianName: String? = nil
    ) async throws -> (inviteId: String, token: String?, shareUrl: String?, inviteCode: String?, voiceCode: String?, guardianInstruction: String?, channelHandle: String?)? {
        var body: [String: Any] = ["sourceChannel": sourceChannel]
        if let note { body["note"] = note }
        if let maxUses { body["maxUses"] = maxUses }
        if let contactName { body["contactName"] = contactName }
        if let contactId { body["contactId"] = contactId }
        if let expectedExternalUserId { body["expectedExternalUserId"] = expectedExternalUserId }
        if let friendName { body["friendName"] = friendName }
        if let guardianName { body["guardianName"] = guardianName }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/contacts/invites", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("createInvite failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        let decoded = try JSONDecoder().decode(CreateInviteResponse.self, from: response.data)
        guard let invite = decoded.invite else { return nil }
        return (
            inviteId: invite.id,
            token: invite.token,
            shareUrl: invite.share?.url,
            inviteCode: invite.inviteCode,
            voiceCode: invite.voiceCode,
            guardianInstruction: invite.guardianInstruction,
            channelHandle: invite.channelHandle
        )
    }

    public func triggerInviteCall(inviteId: String) async throws -> Bool {
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/contacts/invites/\(inviteId)/call", json: [:], timeout: 10
        )
        guard response.isSuccess else {
            log.error("triggerInviteCall failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return true
    }

    // MARK: - Contact Queries

    private struct ContactsListResponse: Decodable {
        let ok: Bool
        let contacts: [ContactPayload]
    }

    private struct SingleContactResponse: Decodable {
        let ok: Bool
        let contact: ContactPayload?
    }

    public func fetchContactsList(limit: Int = 50, role: String? = nil) async throws -> [ContactPayload] {
        var params: [String: String] = ["limit": "\(limit)"]
        if let role { params["role"] = role }

        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/contacts", params: params, timeout: 10
        )
        guard response.isSuccess else {
            log.error("fetchContactsList failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return try JSONDecoder().decode(ContactsListResponse.self, from: response.data).contacts
    }

    public func fetchContact(contactId: String) async throws -> ContactPayload? {
        let response = try await GatewayHTTPClient.get(
            path: "assistants/{assistantId}/contacts/\(contactId)", timeout: 10
        )
        guard response.isSuccess else {
            log.error("fetchContact failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return try JSONDecoder().decode(SingleContactResponse.self, from: response.data).contact
    }

    public func deleteContact(contactId: String) async throws -> Bool {
        let response = try await GatewayHTTPClient.delete(
            path: "assistants/{assistantId}/contacts/\(contactId)", timeout: 10
        )
        guard response.isSuccess || response.statusCode == 204 else {
            log.error("deleteContact failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return true
    }

    public func updateContactChannel(
        channelId: String,
        status: String? = nil,
        policy: String? = nil,
        reason: String? = nil
    ) async throws -> ContactPayload? {
        var body: [String: Any] = [:]
        if let status { body["status"] = status }
        if let policy { body["policy"] = policy }
        if let reason { body["reason"] = reason }

        let response = try await GatewayHTTPClient.patch(
            path: "assistants/{assistantId}/contact-channels/\(channelId)", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("updateContactChannel failed (HTTP \(response.statusCode))")
            throw ContactClientError.httpError(statusCode: response.statusCode, serverMessage: Self.parseServerError(from: response.data))
        }
        return try JSONDecoder().decode(SingleContactResponse.self, from: response.data).contact
    }
}
