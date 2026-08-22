import Capacitor
import Foundation

/// Capacitor plugin exposing the remembered self-hosted server list to the web
/// layer, which installs it as the assistant chooser's storage provider. The
/// active slot stays `SelfHostedServer.defaultsKey` (the `Settings.bundle`
/// contract); this plugin generalizes it into a switchable `{name?, url}` list.
///
/// Methods:
/// - `list` resolves `{ servers: [{name?, url}], activeUrl, bakedUrl }`
/// - `add({url, name?})` remembers an origin
/// - `remove({url})` forgets one (clearing the active slot when it matches)
/// - `switchTo({url?})` swaps the shell's origin and reloads in place; an
///   absent/empty url returns to the baked Vellum Cloud origin
///
/// Every method here that changes the ACTIVE origin also drops the widget
/// snapshot, inherited from `SelfHostedServer.setActive` rather than called
/// per method, so the native paths that swap origins without going through
/// this bridge get the same drop. See that type for the invariant.
///
/// Per the skew rule in `clients/web/docs/CAPACITOR.md`, one result shape
/// encodes every state: empty state resolves with an empty list and nulls
/// rather than rejecting, so only genuinely invalid caller input (an `add` or
/// `switchTo` URL failing `SelfHostedServer.validate`) rejects.
@objc(SelfHostedServersPlugin)
public class SelfHostedServersPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SelfHostedServersPlugin"
    public let jsName = "SelfHostedServers"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "add", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchToPath", returnType: CAPPluginReturnPromise),
    ]

    @objc public func list(_ call: CAPPluginCall) {
        let servers: [[String: Any]] = SelfHostedServer.servers().map { entry in
            var item: [String: Any] = ["url": entry.url]
            if let name = entry.name {
                item["name"] = name
            }
            return item
        }
        // The baked URL lives on the bridge view controller, so read it on the
        // main queue.
        DispatchQueue.main.async { [weak self] in
            let baked = (self?.bridge?.viewController as? MyViewController)?.bakedServerURLString
            call.resolve([
                "servers": servers,
                "activeUrl": Self.nullable(SelfHostedServer.configuredURL()?.absoluteString),
                "bakedUrl": Self.nullable(baked),
            ])
        }
    }

    @objc public func add(_ call: CAPPluginCall) {
        guard let url = SelfHostedServer.validate(call.getString("url")) else {
            call.reject("invalid url")
            return
        }
        SelfHostedServer.append(url: url, name: call.getString("name"))
        call.resolve(["ok": true])
    }

    /// Forgetting a URL that is not (or cannot be) in the list is a no-op, so
    /// this never rejects. Removing the active server clears the active slot,
    /// so the shell reloads back to the baked origin like `switchTo({})`, and
    /// the clear carries the widget-snapshot drop with it.
    @objc public func remove(_ call: CAPPluginCall) {
        var removedActive = false
        if let url = SelfHostedServer.validate(call.getString("url")) {
            removedActive = SelfHostedServer.isActive(url)
            SelfHostedServer.remove(url: url)
        }
        // Resolve before scheduling the reload: it tears the web context down,
        // so a caller awaiting this call would otherwise never settle.
        call.resolve(["ok": true])
        guard removedActive else {
            return
        }
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? MyViewController)?.applyConfiguredOrigin()
        }
    }

    /// Switching to a URL implies remembering it, so the target is appended to
    /// the list alongside the active-slot write. The reload itself runs on the
    /// main queue via `MyViewController.applyConfiguredOrigin()`; the runtime
    /// navigation allowance (`NavigationDelegateProxy`) checks the
    /// currently-configured host, so the new origin loads in-app.
    ///
    /// The widget snapshot goes with the swap, dropped by the active-slot write
    /// below rather than left to the web layer, which makes it atomic with the
    /// swap: if the origin changed, the snapshot went with it, with no second
    /// bridge round trip to fail. A swap whose target is the current origin
    /// keeps the snapshot, which still describes the origin on screen.
    @objc public func switchTo(_ call: CAPPluginCall) {
        let raw = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if raw.isEmpty {
            SelfHostedServer.clear()
        } else if let url = SelfHostedServer.validate(raw) {
            SelfHostedServer.store(url)
            SelfHostedServer.append(url: url, name: nil)
        } else {
            call.reject("invalid url")
            return
        }
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? MyViewController)?.applyConfiguredOrigin()
            call.resolve(["ok": true])
        }
    }

    /// `switchTo` plus a route to land on, so it drops the widget snapshot for
    /// the same reason and in the same breath as the origin write.
    @objc public func switchToPath(_ call: CAPPluginCall) {
        let path = call.getString("path")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("://"), !path.contains("#") else {
            call.reject("invalid path")
            return
        }

        let raw = call.getString("url")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if raw.isEmpty {
            SelfHostedServer.clear()
        } else if let url = SelfHostedServer.validate(raw) {
            SelfHostedServer.store(url)
            SelfHostedServer.append(url: url, name: nil)
        } else {
            call.reject("invalid url")
            return
        }
        DispatchQueue.main.async { [weak self] in
            (self?.bridge?.viewController as? MyViewController)?.applyConfiguredOrigin(path: path)
            call.resolve(["ok": true])
        }
    }

    private static func nullable(_ value: String?) -> Any {
        if let value {
            return value
        }
        return NSNull()
    }
}
