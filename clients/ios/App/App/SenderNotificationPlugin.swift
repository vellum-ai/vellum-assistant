import Capacitor
import Foundation
import UserNotifications

private struct SenderNotificationContent: @unchecked Sendable {
    let content: UNNotificationContent
}

/// App-local Capacitor plugin that owns one iOS local-notification post from
/// validation through the notification center callback.
///
/// Methods:
/// - `getCapabilities()` reports bridge contract version 1 and its supported
///   process-local operations.
/// - `prepare(...)` retains one validated scoped sender snapshot in bounded
///   memory and warms the existing content-addressed avatar cache.
/// - `reset(...)` invalidates scoped sender memory without touching in-flight
///   delivery ownership or the existing byte cache.
/// - `post(...)` claims a full delivery key, chooses communication or original
///   content by a native deadline, and submits one request.
/// - `status(...)` reads the in-memory state for that same full delivery key.
///
/// The plugin does not register a notification-center delegate. Capacitor's
/// LocalNotifications plugin keeps that role, including retained action
/// callbacks, and reads this plugin's `cap_extra` payload on taps.
@objc(SenderNotificationPlugin)
public class SenderNotificationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SenderNotificationPlugin"
    public let jsName = "SenderNotification"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    private static let coordinator = LocalNotificationCoordinator<SenderNotificationContent>(
        contentPreparer: { plain, sender, suppressGroupTitle in
            let payload = SenderPayload(
                id: sender.id,
                name: sender.name,
                avatarURL: .absent,
                avatarHash: sender.avatar.hash
            )
            let updated = try await communicationContent(
                from: plain.content,
                sender: payload,
                avatar: sender.avatar.data,
                suppressGroupTitle: suppressGroupTitle
            )
            return SenderNotificationContent(content: updated)
        },
        notificationWriter: { notificationId, content in
            await writeNotification(id: notificationId, content: content.content)
        }
    )

    @objc public func getCapabilities(_ call: CAPPluginCall) {
        call.resolve([
            "version": 1,
            "capabilities": [
                "preparedIdentity",
                "singlePostOwner",
                "deliveryStatus",
            ],
        ])
    }

    @objc public func prepare(_ call: CAPPluginCall) {
        guard let identity = Self.identity(from: call.getObject("identity")),
              let scopeEpoch = call.getInt("scopeEpoch"),
              let identityRevision = call.getInt("identityRevision"),
              scopeEpoch >= 0,
              identityRevision >= 0
        else {
            call.resolve(["ok": false])
            return
        }

        let name = Self.preparedName(from: call)
        let avatar = Self.avatar(from: call.getObject("avatar"))
        if let avatar {
            AvatarCache.inAppGroup()?.store(avatar.data, hash: avatar.hash)
        }
        guard name != nil || avatar != nil else {
            call.resolve(["ok": false])
            return
        }

        let update = LocalNotificationPreparedIdentityUpdate(
            identity: identity,
            scopeEpoch: scopeEpoch,
            identityRevision: identityRevision,
            name: name,
            avatar: avatar
        )
        Task {
            let accepted = await Self.coordinator.prepare(update)
            call.resolve(["ok": accepted])
        }
    }

    @objc public func reset(_ call: CAPPluginCall) {
        guard let scopeId = Self.identityString(call.getString("scopeId")),
              let scopeEpoch = call.getInt("scopeEpoch"),
              scopeEpoch >= 0
        else {
            call.resolve(["ok": false])
            return
        }
        let assistantId: String?
        if call.getValue("assistantId") != nil {
            guard let parsed = Self.identityString(call.getString("assistantId")) else {
                call.resolve(["ok": false])
                return
            }
            assistantId = parsed
        } else {
            assistantId = nil
        }
        let identityRevision: Int?
        if call.getValue("identityRevision") != nil {
            guard let parsed = call.getInt("identityRevision"), parsed >= 0 else {
                call.resolve(["ok": false])
                return
            }
            identityRevision = parsed
        } else {
            identityRevision = nil
        }
        Task {
            let accepted = await Self.coordinator.reset(
                scopeId: scopeId,
                scopeEpoch: scopeEpoch,
                assistantId: assistantId,
                identityRevision: identityRevision
            )
            call.resolve(["ok": accepted])
        }
    }

    @objc public func post(_ call: CAPPluginCall) {
        guard let deliveryKey = Self.deliveryKey(from: call) else {
            call.resolve(Self.resultObject(.failed(
                postingMayHaveBegun: false,
                errorMessage: "missing_delivery_key"
            )))
            return
        }
        guard let notificationId = call.getInt("id"),
              let title = call.getString("title"),
              let body = call.getString("body")
        else {
            call.resolve(Self.resultObject(.failed(
                postingMayHaveBegun: false,
                errorMessage: "invalid_notification_content"
            )))
            return
        }

        let presentation = LocalNotificationPresentation(
            rawValue: call.getString("presentation") ?? "app"
        ) ?? .app
        let identity = Self.identity(from: call.getObject("identity"))
        let provenance = LocalNotificationNameProvenance(
            rawValue: call.getString("nameProvenance") ?? ""
        )
        let senderInput = presentation == .assistant
            ? Self.sender(from: call)
            : .absent
        if case .valid(let sender) = senderInput {
            AvatarCache.inAppGroup()?.store(sender.avatar.data, hash: sender.avatar.hash)
        }

        let content = UNMutableNotificationContent()
        content.title = NSString.localizedUserNotificationString(forKey: title, arguments: nil)
        content.body = NSString.localizedUserNotificationString(forKey: body, arguments: nil)
        content.userInfo = ["cap_extra": call.getObject("extra") ?? [:]]
        if let actionTypeId = Self.optionalIdentityString(call.getString("actionTypeId")) {
            content.categoryIdentifier = actionTypeId
        }
        if presentation == .assistant, let identity {
            content.threadIdentifier = identity.nativeSenderId
        }

        let senderName: String?
        if presentation == .assistant,
           let explicit = Self.senderName(
               call.getString("name") ?? call.getString("senderName")
           ) {
            senderName = explicit
        } else if provenance == .title {
            senderName = Self.senderName(title)
        } else {
            senderName = nil
        }
        let request = LocalNotificationPostRequest(
            deliveryKey: deliveryKey,
            notificationId: notificationId,
            plainContent: SenderNotificationContent(content: content),
            presentation: presentation,
            identity: identity,
            senderName: senderName,
            nameProvenance: provenance,
            suppressGroupTitle: call.getBool("suppressGroupTitle") == true && provenance == .title,
            inlineSender: senderInput.sender,
            inlineSenderInvalid: senderInput.isInvalid
        )
        Task {
            let result = await Self.coordinator.post(request)
            call.resolve(Self.resultObject(result))
        }
    }

    @objc public func status(_ call: CAPPluginCall) {
        guard let deliveryKey = Self.deliveryKey(from: call) else {
            call.resolve(Self.resultObject(.unavailable(reason: "missing_delivery_key")))
            return
        }
        Task {
            let result = await Self.coordinator.status(for: deliveryKey)
            call.resolve(Self.resultObject(result))
        }
    }

    private static func writeNotification(
        id: Int,
        content: UNNotificationContent
    ) async -> LocalNotificationDeliveryResult {
        let center = UNUserNotificationCenter.current()
        let settings = await withCheckedContinuation { continuation in
            center.getNotificationSettings { continuation.resume(returning: $0) }
        }
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .denied:
            return .blocked(reason: "authorization_denied")
        case .notDetermined:
            return .blocked(reason: "authorization_not_determined")
        @unknown default:
            return .unknown(errorMessage: "authorization_status_unknown")
        }

        let request = UNNotificationRequest(
            identifier: String(id),
            content: content,
            trigger: nil
        )
        return await withCheckedContinuation { continuation in
            center.add(request) { error in
                if let error {
                    continuation.resume(returning: .failed(
                        postingMayHaveBegun: true,
                        errorMessage: error.localizedDescription
                    ))
                    return
                }
                continuation.resume(returning: .posted)
            }
        }
    }

    private static func identity(from object: JSObject?) -> LocalNotificationIdentity? {
        guard let object,
              let scopeId = identityString(object["scopeId"] as? String),
              let assistantId = identityString(object["assistantId"] as? String),
              let nativeSenderId = identityString(object["nativeSenderId"] as? String)
        else {
            return nil
        }
        return LocalNotificationIdentity(
            scopeId: scopeId,
            assistantId: assistantId,
            nativeSenderId: nativeSenderId
        )
    }

    private static func preparedName(from call: CAPPluginCall) -> String? {
        guard let name = senderName(call.getString("name")),
              let provenance = LocalNotificationNameProvenance(
                  rawValue: call.getString("nameProvenance") ?? ""
              ),
              provenance != .title
        else {
            return nil
        }
        return name
    }

    private static func avatar(from object: JSObject?) -> LocalNotificationAvatar? {
        guard let object,
              let base64 = object["avatarBase64"] as? String,
              let hash = object["avatarHash"] as? String
        else {
            return nil
        }
        return LocalNotificationAvatarValidator.decode(base64: base64, expectedHash: hash)
    }

    private enum SenderInput {
        case absent
        case valid(LocalNotificationSender)
        case invalid

        var sender: LocalNotificationSender? {
            if case .valid(let sender) = self {
                return sender
            }
            return nil
        }

        var isInvalid: Bool {
            if case .invalid = self {
                return true
            }
            return false
        }
    }

    private static func sender(from call: CAPPluginCall) -> SenderInput {
        guard call.getValue("sender") != nil else {
            return .absent
        }
        guard let object = call.getObject("sender") else {
            return .invalid
        }
        guard let id = identityString(object["id"] as? String),
              let name = senderName(object["name"] as? String),
              let base64 = object["avatarBase64"] as? String,
              let hash = object["avatarHash"] as? String,
              let avatar = LocalNotificationAvatarValidator.decode(
                  base64: base64,
                  expectedHash: hash
              )
        else {
            return .invalid
        }
        return .valid(LocalNotificationSender(id: id, name: name, avatar: avatar))
    }

    private static func deliveryKey(from call: CAPPluginCall) -> String? {
        LocalNotificationDeliveryKey.resolve(
            correlationId: call.getString("correlationId"),
            deliveryId: call.getString("deliveryId"),
            requestKey: call.getString("requestKey")
        )
    }

    private static func identityString(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 512 else {
            return nil
        }
        return trimmed
    }

    private static func optionalIdentityString(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        return identityString(value)
    }

    private static func senderName(_ value: String?) -> String? {
        guard let value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 256 else {
            return nil
        }
        return trimmed
    }

    private static func resultObject(_ result: LocalNotificationDeliveryResult) -> JSObject {
        switch result {
        case .posted:
            return ["status": "posted"]
        case .duplicate:
            return ["status": "duplicate"]
        case .blocked(let reason):
            var object: JSObject = ["status": "blocked"]
            object["reason"] = reason
            return object
        case .failed(let postingMayHaveBegun, let errorMessage):
            var object: JSObject = [
                "status": "failed",
                "postingMayHaveBegun": postingMayHaveBegun,
            ]
            object["errorMessage"] = errorMessage
            return object
        case .unknown(let errorMessage):
            var object: JSObject = ["status": "unknown"]
            object["errorMessage"] = errorMessage
            return object
        case .unavailable(let reason):
            var object: JSObject = ["status": "unavailable"]
            object["reason"] = reason
            return object
        }
    }
}
