import Foundation

/// Cross-platform string utilities shared across macOS and iOS targets.
public enum VStringUtils {
    /// Counts newlines without allocating N substrings.
    /// Equivalent to `text.components(separatedBy: "\n").count` but O(1) memory.
    public static func countLines(in text: String) -> Int {
        var count = 1
        for byte in text.utf8 where byte == 0x0A { count += 1 }
        return count
    }
}
