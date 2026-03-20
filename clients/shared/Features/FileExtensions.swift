import Foundation

/// Common file extension classifications used for icon display and file type detection.
public enum FileExtensions {
    private static let codeExtensions: Set<String> = [
        // Programming languages
        "py", "rb", "go", "rs", "swift", "kt", "kts", "cs", "scala", "java", "c", "h", "cpp", "cc", "hpp",
        "ex", "exs", "erl", "hs", "clj", "cljs", "jl", "zig", "nim", "sol", "r", "dart", "php", "pl", "lua",
        // Shell / scripting
        "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "awk",
        // Web frameworks
        "vue", "svelte", "scss", "sass", "less",
        // Query / schema
        "sql", "graphql", "gql", "proto", "tf", "hcl",
        // Config / data
        "cfg", "conf", "ini", "properties", "gradle", "cmake", "toml", "yaml", "yml",
    ]

    public static func isCode(_ fileName: String) -> Bool {
        guard let ext = fileName.split(separator: ".").last?.lowercased() else { return false }
        return codeExtensions.contains(ext)
    }
}
