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

    /// Persist a validated origin under the shared defaults key.
    static func store(_ url: URL, defaults: UserDefaults = .standard) {
        defaults.set(url.absoluteString, forKey: defaultsKey)
    }

    /// Clear the preference, returning the shell to the baked Vellum Cloud URL.
    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }

    /// The remembered server list. Entries failing `validate` are dropped, and
    /// a legacy active URL absent from the stored list is included (name nil)
    /// without writing back until the next mutation.
    static func servers(defaults: UserDefaults = .standard) -> [Entry] {
        var entries: [Entry] = []
        if let data = defaults.data(forKey: serversKey),
           let decoded = try? JSONDecoder().decode([Entry].self, from: data) {
            for item in decoded {
                guard let url = validate(item.url),
                      !entries.contains(where: { $0.url == url.absoluteString })
                else {
                    continue
                }
                entries.append(Entry(name: normalizedName(item.name), url: url.absoluteString))
            }
        }
        if let active = configuredURL(defaults: defaults),
           !entries.contains(where: { $0.url == active.absoluteString }) {
            entries.append(Entry(name: nil, url: active.absoluteString))
        }
        return entries
    }

    /// Remember an origin, deduped by absolute string. A re-append with a name
    /// updates the label; a nameless re-append keeps the existing one, so
    /// switching to a remembered server never wipes its label.
    static func append(url: URL, name: String?, defaults: UserDefaults = .standard) {
        var entries = servers(defaults: defaults)
        let name = normalizedName(name)
        if let index = entries.firstIndex(where: { $0.url == url.absoluteString }) {
            if let name {
                entries[index].name = name
            }
        } else {
            entries.append(Entry(name: name, url: url.absoluteString))
        }
        persist(entries, defaults: defaults)
    }

    /// Forget an origin. When it is also the active URL, the active slot is
    /// cleared so the shell falls back to the baked default.
    static func remove(url: URL, defaults: UserDefaults = .standard) {
        var entries = servers(defaults: defaults)
        entries.removeAll { $0.url == url.absoluteString }
        persist(entries, defaults: defaults)
        if configuredURL(defaults: defaults)?.absoluteString == url.absoluteString {
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
