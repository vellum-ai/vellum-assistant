import Capacitor
import Foundation

/// Capacitor plugin the web layer uses to mirror its sidebar conversation
/// list into `RecentChatsStore`, so the Shortcuts app's chat picker
/// (`ChatEntityQuery`) has something to offer without a network stack or
/// auth of its own.
///
/// One method:
/// - `sync({ chats: [{id, title}] })` replaces the whole cache with the given
///   list, newest first. Full replacement rather than a diff keeps the
///   contract trivial: the web side owns ordering and membership, and a sync
///   after archiving or renaming needs no tombstones.
///
/// Entries missing an `id` or `title` are dropped rather than rejecting the
/// call: a partial cache beats none, and the web producer already shapes the
/// payload. Per the skew rule in `clients/web/docs/CAPACITOR.md`, the one
/// result shape (`{ok: true}`) covers every state, including an empty list.
@objc(RecentChatsPlugin)
public class RecentChatsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RecentChatsPlugin"
    public let jsName = "RecentChats"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
    ]

    @objc public func sync(_ call: CAPPluginCall) {
        let chats = (call.getArray("chats") ?? []).compactMap { item -> RecentChat? in
            guard let dict = item as? [String: Any],
                  let id = dict["id"] as? String, !id.isEmpty,
                  let title = dict["title"] as? String, !title.isEmpty
            else {
                return nil
            }
            return RecentChat(id: id, title: title)
        }
        RecentChatsStore.save(chats)
        call.resolve(["ok": true])
    }
}
