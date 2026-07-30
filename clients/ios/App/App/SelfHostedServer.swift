import Foundation

/// The self-hosted assistant origin the shell points its `WKWebView` at instead
/// of the baked Vellum Cloud URL.
///
/// The value lives in `UserDefaults` under `self_hosted_server_url`, written
/// either from the native Settings pane (`Settings.bundle`) or the
/// `vellum-assistant://connect` deep link. An empty or absent value means the
/// shell uses its baked default (Vellum Cloud), which is the unchanged default
/// experience. This type is the single reader/validator shared by
/// `MyViewController` (boot + foreground override) and `AppDelegate` (connect
/// deep link) so the key and the validation rules live in exactly one place.
enum SelfHostedServer {
    /// `UserDefaults` key shared with the `Settings.bundle` pane. This exact
    /// string is the read/write contract with the settings `Root.plist`.
    static let defaultsKey = "self_hosted_server_url"

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
}
