import Foundation

struct TestCase {
    let name: String
    let filePath: String
    let fixture: String?
    let rawContent: String
}

struct ParsedFrontmatter {
    let fixture: String?
    let body: String
}

func parseFrontmatter(_ content: String) -> ParsedFrontmatter {
    // Match YAML frontmatter between --- delimiters
    guard let range = content.range(of: "^---\n([\\s\\S]*?)\n---\n([\\s\\S]*)$", options: .regularExpression) else {
        return ParsedFrontmatter(fixture: nil, body: content)
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
    for line in frontmatterLines {
        let parts = line.split(separator: ":", maxSplits: 1)
        if parts.count == 2 && parts[0].trimmingCharacters(in: .whitespaces) == "fixture" {
            fixture = parts[1].trimmingCharacters(in: .whitespaces)
        }
    }

    let body = bodyLines.joined(separator: "\n")
    return ParsedFrontmatter(fixture: fixture, body: body)
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

        cases.append(TestCase(name: name, filePath: filePath, fixture: parsed.fixture, rawContent: rawContent))
    }

    return cases
}
