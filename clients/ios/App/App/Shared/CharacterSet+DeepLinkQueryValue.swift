import Foundation

extension CharacterSet {
    /// Characters left unescaped in a deep-link query *value*.
    ///
    /// `URLComponents.queryItems` encodes with `urlQueryAllowed`, which permits
    /// the sub-delimiters `&`, `=`, `+`, and `?`. That is correct for a whole
    /// query string and wrong for a single value inside one: a "Ben & Jerry's"
    /// would arrive at the parser as a truncated value plus a stray parameter.
    /// Removing those four and assigning through `percentEncodedQueryItems` is
    /// the standard fix: the value is escaped once, by the producer, with
    /// delimiters included.
    ///
    /// Used by every producer that puts free-form text into a custom-scheme
    /// command URL (`VoiceModeDeepLink`'s `prompt`, `ThreadDeepLink`'s
    /// `message`), so all of them escape identically.
    static let deepLinkQueryValueAllowed: CharacterSet = {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return allowed
    }()
}
