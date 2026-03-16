import Foundation

/// Formats a byte count into a human-readable, locale-aware size string.
/// Uses `ByteCountFormatter` with `.file` count style for proper unit scaling
/// and localized labels/decimal separators.
public func formatFileSize(_ bytes: Int) -> String {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    return formatter.string(fromByteCount: Int64(bytes))
}
