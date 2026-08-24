import Foundation

/// The self-hosted assistant origin the shell points its `WKWebView` at instead
/// of the baked Vellum Cloud URL.
///
/// The active value lives in `UserDefaults` under `self_hosted_server_url`,
/// written either from the native Settings pane (`Settings.bundle`), the
/// `vellum-assistant://connect` deep link, or the `SelfHostedServers` plugin.
/// An empty or absent value means the shell uses its baked default (Vellum
/// Cloud), which is the unchanged default experience. Alongside the active
/// slot, `self_hosted_servers` remembers every paired origin as a
/// `{name?, url}` list so the web chooser can switch between them. This type
/// is the single reader/validator shared by `MyViewController` (boot +
/// foreground override), `AppDelegate` (connect deep link), and
/// `SelfHostedServersPlugin` so the keys and the validation rules live in
/// exactly one place.
///
/// `setActive` is also the choke point for one invariant: any change of the
/// active origin drops the widget snapshot. That App Group cache describes the
/// conversations of the origin being left, and the destination is a different
/// deployment with its own account and list, so those titles must not stay on
/// a Home Screen that never reloads on its own. The web layer cannot carry the
/// obligation across the boundary, because every record it could leave behind
/// (the producer id, an unfinished-clear marker) lives in localStorage, which
/// is per-origin, so the destination reads none of it.
///
/// The drop is expressed as a recording rather than a call to clear:
/// `WidgetSnapshotPlugin.recordAppliedOrigin` compares `activeOriginIdentity`
/// against the origin mirrored in the App Group beside the snapshot, and clears
/// only on a change. Three callers make that cover every way the active origin
/// moves:
///
///  1. `setActive`, so each in-app path inherits the drop without a call of its
///     own: the plugin's `switchTo`, `switchToPath` and `remove`, the `connect`
///     deep link on both a warm open and a cold launch, and the
///     unreachable-server alert's "Use Vellum Cloud" fallback.
///  2. `MyViewController.reloadIfConfiguredOriginChanged()`, for the iOS
///     Settings pane, the one writer that goes straight to `UserDefaults`
///     behind this type's back while the app is running.
///  3. `MyViewController.instanceDescriptor()`, where a launch applies the
///     origin it finds. This is the case no in-memory comparison can make: a
///     Settings change against a terminated app leaves no previous value in the
///     process that boots on the new origin, and only the mirror, which outlives
///     the process because it sits in the container it describes, still knows
///     which origin the snapshot came from.
enum SelfHostedServer {
    /// `UserDefaults` key shared with the `Settings.bundle` pane. This exact
    /// string is the read/write contract with the settings `Root.plist`.
    static let defaultsKey = "self_hosted_server_url"

    /// `UserDefaults` key holding the remembered server list as a JSON array
    /// of `{"name": String?, "url": String}`.
    static let serversKey = "self_hosted_servers"

    /// A remembered self-hosted server: a validated https origin plus an
    /// optional user-facing label (from the pairing deep link's `name` param).
    struct Entry: Codable, Equatable {
        var name: String?
        var url: String
    }

    /// The validated self-hosted origin, or `nil` when the preference is unset
    /// or invalid so callers fall back to the baked default.
    static func configuredURL(defaults: UserDefaults = .standard) -> URL? {
        return validate(defaults.string(forKey: defaultsKey))
    }

    /// Parse and validate a candidate server URL: trims whitespace and requires
    /// a parseable `https:` URL carrying a host. Returns `nil` for anything else
    /// so a malformed preference can never break the boot or steer the shell to
    /// an unexpected origin. `https:` is mandatory because iOS App Transport
    /// Security requires valid TLS and the shell keeps `server.cleartext` off.
    static func validate(_ raw: String?) -> URL? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty,
              let url = URL(string: trimmed),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty
        else {
            return nil
        }
        return url
    }

    /// Canonical identity of a server URL, shared with the web chooser's
    /// remembered-origins store (`normalizeOriginUrl`): lowercase scheme and
    /// host, userinfo dropped, trailing slashes stripped from the path, query
    /// and fragment dropped, path and port preserved. Every list-identity and
    /// active-slot comparison goes through this so the iOS list and the web
    /// store agree on which strings mean the same server. The active slot
    /// itself stores the raw validated URL (the `Settings.bundle` contract).
    static func canonicalize(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        // The web's URL.origin collapses the scheme default port; match it
        // (validate only admits https).
        if components.port == 443 {
            components.port = nil
        }
        // Trim through the percent-encoded path so escaped separators
        // (e.g. %2F) survive the round-trip instead of being decoded.
        while components.percentEncodedPath.hasSuffix("/") {
            components.percentEncodedPath = String(components.percentEncodedPath.dropLast())
        }
        return components.url ?? url
    }

    /// `canonicalize` as the string used for list entries and equality.
    static func canonicalString(_ url: URL) -> String {
        return canonicalize(url).absoluteString
    }

    /// The active origin as the single string every widget-snapshot comparison
    /// is made on: the canonical configured origin, or `""` when none is set,
    /// meaning the shell serves its baked Vellum Cloud URL.
    ///
    /// The cloud case is a value rather than an absence so that leaving it, or
    /// returning to it, reads as a change like any other; `nil` stays free to
    /// mean "never recorded" in `WidgetSnapshotStore.appliedOrigin()`. The baked
    /// URL cannot be named here (it comes from the Capacitor descriptor) and
    /// does not need to be: the preference is what every origin change writes,
    /// so its canonical form identifies the origin either way.
    static func activeOriginIdentity(defaults: UserDefaults = .standard) -> String {
        return configuredURL(defaults: defaults).map(canonicalString) ?? ""
    }

    /// Whether a URL canonically matches the active slot.
    static func isActive(_ url: URL, defaults: UserDefaults = .standard) -> Bool {
        guard let active = configuredURL(defaults: defaults) else {
            return false
        }
        return canonicalString(active) == canonicalString(url)
    }

    /// Persist a validated origin under the shared defaults key.
    static func store(_ url: URL, defaults: UserDefaults = .standard) {
        setActive(url.absoluteString, defaults: defaults)
    }

    /// Clear the preference, returning the shell to the baked Vellum Cloud URL.
    static func clear(defaults: UserDefaults = .standard) {
        setActive(nil, defaults: defaults)
    }

    /// The single writer of the active slot, and with it the single in-app
    /// place the widget snapshot is bound to an origin (see the type doc).
    ///
    /// The recording drops the snapshot only when the effective origin actually
    /// moves, compared canonically so a re-write of the same server in a
    /// different spelling stays a no-op. Switching to the origin already active
    /// therefore keeps the snapshot it belongs to, and clearing an
    /// already-absent preference leaves the baked cloud origin's snapshot alone.
    private static func setActive(_ raw: String?, defaults: UserDefaults) {
        if let raw {
            defaults.set(raw, forKey: defaultsKey)
        } else {
            defaults.removeObject(forKey: defaultsKey)
        }
        WidgetSnapshotPlugin.recordAppliedOrigin(activeOriginIdentity(defaults: defaults))
    }

    /// The remembered server list, entries keyed by canonical URL. Entries
    /// failing `validate` are dropped, stored urls re-canonicalize on read
    /// (deduping any pre-canonical duplicates, first entry wins), and a
    /// legacy active URL absent from the stored list is included (name nil)
    /// without writing back until the next mutation.
    static func servers(defaults: UserDefaults = .standard) -> [Entry] {
        var entries: [Entry] = []
        if let data = defaults.data(forKey: serversKey),
           let decoded = try? JSONDecoder().decode([Entry].self, from: data) {
            for item in decoded {
                guard let url = validate(item.url) else {
                    continue
                }
                let canonical = canonicalString(url)
                guard !entries.contains(where: { $0.url == canonical }) else {
                    continue
                }
                entries.append(Entry(name: normalizedName(item.name), url: canonical))
            }
        }
        if let active = configuredURL(defaults: defaults) {
            let canonical = canonicalString(active)
            if !entries.contains(where: { $0.url == canonical }) {
                entries.append(Entry(name: nil, url: canonical))
            }
        }
        return entries
    }

    /// Remember an origin, deduped by canonical URL. A re-append with a name
    /// updates the label; a nameless re-append keeps the existing one, so
    /// switching to a remembered server never wipes its label.
    static func append(url: URL, name: String?, defaults: UserDefaults = .standard) {
        var entries = servers(defaults: defaults)
        let name = normalizedName(name)
        let canonical = canonicalString(url)
        if let index = entries.firstIndex(where: { $0.url == canonical }) {
            if let name {
                entries[index].name = name
            }
        } else {
            entries.append(Entry(name: name, url: canonical))
        }
        persist(entries, defaults: defaults)
    }

    /// Forget an origin, matched by canonical URL. When it is also the active
    /// URL, the active slot is cleared so the shell falls back to the baked
    /// default.
    static func remove(url: URL, defaults: UserDefaults = .standard) {
        var entries = servers(defaults: defaults)
        entries.removeAll { $0.url == canonicalString(url) }
        persist(entries, defaults: defaults)
        if isActive(url, defaults: defaults) {
            clear(defaults: defaults)
        }
    }

    private static func persist(_ entries: [Entry], defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(entries) else {
            return
        }
        defaults.set(data, forKey: serversKey)
    }

    /// Trim a label and collapse an empty one to nil.
    private static func normalizedName(_ name: String?) -> String? {
        guard let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else {
            return nil
        }
        return trimmed
    }
}
