import Foundation

// MARK: - Text Preview

extension ChatAttachment {

    /// MIME types that are always previewable as text, beyond the `text/*` prefix.
    private static let textMimeTypes: Set<String> = [
        "application/json",
        "application/xml",
        "application/javascript",
        "application/typescript",
        "application/x-yaml",
        "application/toml",
        "application/x-sh",
    ]

    /// File extensions for common text/config files that may not be classified as
    /// code by `FileExtensions.isCode` and may lack a recognised MIME type.
    private static let textFileExtensions: Set<String> = [
        "md", "markdown", "txt", "json", "jsonl", "ndjson",
        "xml", "yaml", "yml", "toml", "csv", "tsv", "log",
        "cfg", "conf", "ini", "env", "gitignore", "dockerignore",
        "editorconfig", "properties",
    ]

    /// Map from file extension to language identifier for syntax highlighting.
    private static let extensionToLanguage: [String: String] = [
        "py": "python",
        "js": "javascript",
        "ts": "typescript",
        "rb": "ruby",
        "rs": "rust",
        "go": "go",
        "swift": "swift",
        "java": "java",
        "cpp": "cpp",
        "cc": "cpp",
        "hpp": "cpp",
        "c": "c",
        "h": "c",
        "sh": "bash",
        "bash": "bash",
        "zsh": "bash",
        "sql": "sql",
        "yaml": "yaml",
        "yml": "yaml",
        "toml": "toml",
        "json": "json",
        "jsonl": "json",
        "xml": "xml",
        "html": "html",
        "css": "css",
        "md": "markdown",
        "markdown": "markdown",
    ]

    /// Whether this attachment can be rendered as an inline text preview.
    public var isTextPreviewable: Bool {
        // text/* MIME family
        if mimeType.hasPrefix("text/") { return true }

        // Known text-like MIME types
        if Self.textMimeTypes.contains(mimeType) { return true }

        // Broad JSON-family match (application/jsonl, application/x-ndjson, etc.)
        if mimeType.contains("json") { return true }

        // Fall back to file extension checks
        let ext = (filename as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return false }

        if FileExtensions.isCode(filename) { return true }
        if Self.textFileExtensions.contains(ext) { return true }

        return false
    }

    /// Decode the base64-encoded `data` payload as a UTF-8 string.
    /// Returns `nil` when `data` is empty (lazy-load attachment) or the content
    /// is not valid UTF-8.
    public func decodedTextContent() -> String? {
        guard !data.isEmpty else { return nil }
        guard let raw = Data(base64Encoded: data) else { return nil }
        return String(data: raw, encoding: .utf8)
    }

    /// Language hint derived from the file extension, suitable for fenced code
    /// block rendering. Returns `nil` for unrecognised extensions.
    public var fileLanguageHint: String? {
        let ext = (filename as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return nil }
        return Self.extensionToLanguage[ext]
    }
}
