import Foundation

/// Marketing attribution carried from the web layer into the platform's
/// provider-token exchange.
///
/// The native shell has no cookie jar the marketing site ever wrote to, so a
/// signup started here arrives unattributed unless the web layer hands the
/// campaign params across the bridge and we put them on the wire.
///
/// The allowlist and the truncation length mirror `ATTRIBUTION_PARAMS` and
/// `ATTRIBUTION_VALUE_MAX_LENGTH` in
/// `clients/web/src/domains/account/social-auth.ts` (the source of truth) and
/// `Attribution.java` in the Android shell. All three must be changed together.
enum Attribution {
    static let keys: [String] = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "gclid",
        "gbraid",
        "wbraid",
        "msclkid",
        "fbclid",
        "ttclid",
        "li_fat_id",
        "twclid",
    ]

    /// The platform truncates per field independently; this only bounds what
    /// we put on the wire.
    static let valueMaxLength = 512

    /// RFC 3986 unreserved characters. Everything else is percent-encoded so
    /// Django's query parser cannot reinterpret it. `+` is the one that
    /// bites: left raw, `parse_qsl` decodes it back as a space.
    private static let unreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Allowlisted, non-empty, truncated fields from a raw bridge payload.
    /// Anything else the caller sent is dropped.
    static func fields(from raw: [String: Any]?) -> [String: String] {
        guard let raw = raw else { return [:] }
        var collected: [String: String] = [:]
        for key in keys {
            guard let value = raw[key] as? String, !value.isEmpty else { continue }
            collected[key] = String(value.prefix(valueMaxLength))
        }
        return collected
    }

    /// Percent-encoded `key=value` pairs in ``keys`` order, or `""` when
    /// nothing survives. Callers leave the request query unset on `""`, so a
    /// call without attribution carries no query string.
    static func query(from fields: [String: String]) -> String {
        keys.compactMap { key in
            guard let value = fields[key], !value.isEmpty else { return nil }
            return "\(encode(key))=\(encode(value))"
        }.joined(separator: "&")
    }

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}
