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

    /// Whether a URL canonically matches the active slot.
    static func isActive(_ url: URL, defaults: UserDefaults = .standard) -> Bool {
        guard let active = configuredURL(defaults: defaults) else {
            return false
        }
        return canonicalString(active) == canonicalString(url)
    }

    /// Persist a validated origin under the shared defaults key.
    static func store(_ url: URL, defaults: UserDefaults = .standard) {
        defaults.set(url.absoluteString, forKey: defaultsKey)
    }

    /// Clear the preference, returning the shell to the baked Vellum Cloud URL.
    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
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
