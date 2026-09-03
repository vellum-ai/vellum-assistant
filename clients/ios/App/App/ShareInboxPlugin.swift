import Capacitor
import Foundation

/// Capacitor plugin the web layer uses to drain the App Group share inbox
/// the share extension writes.
///
/// One method:
/// - `consume({ id? })` returns `{ ok, item }` and deletes the inbox item.
///   `item` is `null` when the id is missing, stale, or already consumed.
///   With no `id`, the newest unexpired item is taken. Files are copied into
///   the host cache first so the web layer can read them after the inbox
///   directory is gone.
///
/// `load()` observes the Darwin `ai.vellum.share-inbox-ready` notification
/// the extension posts after a write and emits `inboxReady`, so a host
/// already in memory can drain without waiting for the command URL.
///
/// Per the skew rule in `clients/web/docs/CAPACITOR.md`, the one result
/// shape covers every state, including an empty inbox.
@objc(ShareInboxPlugin)
public class ShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShareInboxPlugin"
    public let jsName = "ShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "consume", returnType: CAPPluginReturnPromise),
    ]

    public override func load() {
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            observer,
            { _, observer, _, _, _ in
                guard let observer else {
                    return
                }
                let plugin = Unmanaged<ShareInboxPlugin>.fromOpaque(observer)
                    .takeUnretainedValue()
                DispatchQueue.main.async {
                    plugin.notifyListeners("inboxReady", data: [:])
                }
            },
            ShareInbox.readyNotificationName,
            nil,
            .deliverImmediately
        )
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque()
        )
    }

    @objc public func consume(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let result: ShareInboxConsumption?
        if let id, !id.isEmpty {
            result = ShareInbox.consume(id: id)
        } else {
            result = ShareInbox.consumeLatest()
        }
        call.resolve(["ok": true, "item": Self.encode(result) as Any])
    }

    private static func encode(_ item: ShareInboxConsumption?) -> [String: Any]? {
        guard let item else {
            return nil
        }
        let destination: [String: Any]
        switch item.destination {
        case .newConversation:
            destination = ["type": "new"]
        case .thread(let threadId):
            destination = ["type": "thread", "threadId": threadId]
        }
        return [
            "id": item.id,
            "destination": destination,
            "text": item.text as Any,
            "files": item.files.map { file in
                [
                    "name": file.filename,
                    "mimeType": file.mimeType,
                    "path": file.path,
                ]
            },
        ]
    }
}
