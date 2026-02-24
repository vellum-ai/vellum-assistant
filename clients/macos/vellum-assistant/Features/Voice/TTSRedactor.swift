import Foundation

/// Redacts credential-like patterns from assistant text before TTS synthesis.
///
/// Secrets that appear in spoken text (API keys echoed back, tokens mentioned in
/// tool output, etc.) must not be read aloud. Each matched pattern is replaced
/// with a short, naturally spoken placeholder.
enum TTSRedactor {

    // Each entry is (compiled regex, spoken replacement).
    // Patterns are ordered from most specific to most general so that a
    // more-specific rule wins when multiple patterns could match.
    private static let rules: [(NSRegularExpression, String)] = {
        let specs: [(String, String)] = [
            // Anthropic API keys (sk-ant-...)
            (#"sk-ant-[A-Za-z0-9\-_]{20,}"#, "a redacted Anthropic key"),
            // OpenAI project API keys (sk-proj-...)
            (#"sk-proj-[A-Za-z0-9\-_]{20,}"#, "a redacted API key"),
            // Generic OpenAI API keys (sk-...)
            (#"sk-[A-Za-z0-9]{20,}"#, "a redacted API key"),
            // GitHub fine-grained PATs
            (#"github_pat_[A-Za-z0-9_]{82}"#, "a redacted GitHub token"),
            // GitHub classic tokens (ghp_, ghs_, gho_, ghr_)
            (#"gh[phsor]_[A-Za-z0-9]{36}"#, "a redacted GitHub token"),
            // JWT: three base64url segments separated by dots
            (#"eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}"#, "a redacted token"),
            // Bearer tokens (Authorization header value)
            (#"Bearer [A-Za-z0-9\-_.]{20,}"#, "a redacted bearer token"),
            // ElevenLabs-style 32-char alphanumeric keys (no spaces, mixed case)
            (#"\b[0-9a-fA-F]{32}\b"#, "a redacted key"),
            // Long hex strings (40+ chars) — SHA-1/SHA-256 hashes and token IDs
            (#"\b[0-9a-f]{40,}\b"#, "a redacted hash"),
        ]
        return specs.compactMap { (pattern, replacement) in
            guard let regex = try? NSRegularExpression(pattern: pattern) else {
                return nil
            }
            return (regex, replacement)
        }
    }()

    /// Returns `text` with all detected credential patterns replaced by spoken placeholders.
    static func redact(_ text: String) -> String {
        var result = text
        for (regex, replacement) in rules {
            let range = NSRange(result.startIndex..., in: result)
            result = regex.stringByReplacingMatches(
                in: result,
                range: range,
                withTemplate: replacement
            )
        }
        return result
    }
}
