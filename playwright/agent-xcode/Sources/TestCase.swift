import Foundation

struct TestCase {
    let name: String
    let filePath: String
    let fixture: String?
    let experimental: Bool
    let rawContent: String
}

struct ParsedFrontmatter {
    let fixture: String?
    let experimental: Bool
    let body: String
}

func parseFrontmatter(_ content: String) -> ParsedFrontmatter {
    // Match YAML frontmatter between --- delimiters
    guard let range = content.range(of: "^---\n([\\s\\S]*?)\n---\n([\\s\\S]*)$", options: .regularExpression) else {
        return ParsedFrontmatter(fixture: nil, requiredEnv: nil, experimental: false, body: content)
    }

    let matched = String(content[range])
    let lines = matched.components(separatedBy: "\n")

    // Find the second "---" to split frontmatter from body
    var frontmatterLines: [String] = []
    var bodyLines: [String] = []
    var foundFirstDelimiter = false
    var foundSecondDelimiter = false

    for line in lines {
        if line == "---" {
            if !foundFirstDelimiter {
                foundFirstDelimiter = true
                continue
            } else if !foundSecondDelimiter {
                foundSecondDelimiter = true
                continue
            }
        }

        if foundSecondDelimiter {
            bodyLines.append(line)
        } else if foundFirstDelimiter {
            frontmatterLines.append(line)
        }
    }

    var fixture: String?
    var experimental: Bool = false
    for line in frontmatterLines {
        let parts = line.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { continue }
        let key = parts[0].trimmingCharacters(in: .whitespaces)
        let value = parts[1].trimmingCharacters(in: .whitespaces)
        switch key {
        case "fixture":
            fixture = value
        case "experimental":
            experimental = value.lowercased() == "true"
        default:
            break
        }
    }

    let body = bodyLines.joined(separator: "\n")
    return ParsedFrontmatter(fixture: fixture, experimental: experimental, body: body)
}

/// Infer required environment variables from the test file content.
///
/// Scans the body for SCREAMING_SNAKE_CASE identifiers (e.g. ANTHROPIC_API_KEY)
/// that look like environment variable names. Test authors just need to mention
/// the env var name in the markdown body and it will be auto-detected.
func inferRequiredEnv(_ content: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: "\\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\\b") else {
        return []
    }
    let range = NSRange(content.startIndex..., in: content)
    let matches = regex.matches(in: content, range: range)
    var seen = Set<String>()
    var result: [String] = []
    for match in matches {
        if let matchRange = Range(match.range(at: 1), in: content) {
            let envVar = String(content[matchRange])
            if seen.insert(envVar).inserted {
                result.append(envVar)
            }
        }
    }
    return result
}

func discoverTestCases(casesDir: String, filter: String?) -> [TestCase] {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(atPath: casesDir) else {
        return []
    }

    let mdFiles = files.filter { $0.hasSuffix(".md") }.sorted()
    var cases: [TestCase] = []

    for file in mdFiles {
        let filePath = (casesDir as NSString).appendingPathComponent(file)
        guard let rawContent = try? String(contentsOfFile: filePath, encoding: .utf8) else {
            continue
        }

        let parsed = parseFrontmatter(rawContent)
        let name = (file as NSString).deletingPathExtension

        if let filter = filter, !name.contains(filter) {
            continue
        }

        cases.append(TestCase(name: name, filePath: filePath, fixture: parsed.fixture, experimental: parsed.experimental, rawContent: rawContent))
    }

    return cases
}
