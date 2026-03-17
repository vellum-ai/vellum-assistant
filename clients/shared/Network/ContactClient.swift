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
        channels: [DaemonClient.NewContactChannel]?
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
}

/// Gateway-backed implementation of ``ContactClientProtocol``.
@MainActor
public struct ContactClient: ContactClientProtocol {
    nonisolated public init() {}

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
            return nil
        }
        return try JSONDecoder().decode(UpsertResponse.self, from: response.data).contact
    }

    public func createContact(
        displayName: String,
        notes: String? = nil,
        channels: [DaemonClient.NewContactChannel]? = nil
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
            return nil
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
            return nil
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
            return false
        }
        return true
    }
}
