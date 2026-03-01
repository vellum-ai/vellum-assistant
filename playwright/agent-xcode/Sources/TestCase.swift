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
        return ParsedFrontmatter(fixture: nil, experimental: false, body: content)
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

/// Infer required environment variables from the test file content using an LLM.
///
/// Sends the test body to Claude Haiku to identify environment variable names
/// that would need to be set for the test to run. This allows test authors to
/// write natural language without explicitly listing env vars in frontmatter.
func inferRequiredEnv(_ content: String) async -> [String] {
    guard let apiKey = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"] else {
        return []
    }

    let prompt = """
    Analyze the following test case description and identify all environment \
    variable names that would need to be set for this test to run. Look for \
    references to API keys, tokens, secrets, credentials, or any other values \
    that would typically be stored as environment variables.

    Return ONLY a JSON array of environment variable names, e.g. \
    ["ANTHROPIC_API_KEY"]. If none are needed, return [].

    Test case:
    \(content)
    """

    let requestBody: [String: Any] = [
        "model": "claude-3-5-haiku-latest",
        "max_tokens": 256,
        "messages": [
            ["role": "user", "content": prompt]
        ]
    ]

    guard let url = URL(string: "https://api.anthropic.com/v1/messages"),
          let jsonData = try? JSONSerialization.data(withJSONObject: requestBody) else {
        return []
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.addValue(apiKey, forHTTPHeaderField: "x-api-key")
    request.addValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
    request.addValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = jsonData

    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            return []
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let contentArray = json["content"] as? [[String: Any]],
              let firstBlock = contentArray.first,
              let text = firstBlock["text"] as? String else {
            return []
        }

        // Extract JSON array from the response text
        guard let arrayRange = text.range(of: "\\[.*\\]", options: .regularExpression) else {
            return []
        }

        let arrayString = String(text[arrayRange])
        guard let arrayData = arrayString.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: arrayData) as? [String] else {
            return []
        }

        return parsed
    } catch {
        return []
    }
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
