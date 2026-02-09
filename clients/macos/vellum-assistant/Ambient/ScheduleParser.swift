import Foundation

enum ScheduleParser {
    static func parse(from text: String) -> String {
        let lower = text.lowercased()
        var parts: [String] = []

        // Time patterns: "9:30 am", "3pm", "9 am"
        let timeRegex = try! NSRegularExpression(pattern: #"\b\d{1,2}(:\d{2})?\s*(am|pm)\b"#, options: .caseInsensitive)
        let timeMatches = timeRegex.matches(in: lower, range: NSRange(lower.startIndex..., in: lower))
        for match in timeMatches {
            if let range = Range(match.range, in: lower) {
                parts.append(String(lower[range]))
            }
        }

        // Time keywords
        let timeKeywords = ["morning", "evening", "afternoon", "night", "midnight", "noon"]
        for keyword in timeKeywords where lower.contains(keyword) {
            parts.append(keyword)
        }

        // Day patterns
        let dayKeywords = ["weekdays", "weekends", "daily", "weekly", "monthly"]
        for keyword in dayKeywords where lower.contains(keyword) {
            parts.append(keyword)
        }

        // "every Monday", "every Tuesday", etc.
        let everyDayRegex = try! NSRegularExpression(pattern: #"\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b"#, options: .caseInsensitive)
        let everyDayMatches = everyDayRegex.matches(in: lower, range: NSRange(lower.startIndex..., in: lower))
        for match in everyDayMatches {
            if let range = Range(match.range, in: lower) {
                parts.append(String(lower[range]))
            }
        }

        // Frequency patterns: "every N hours/minutes", "hourly", "periodically"
        let freqRegex = try! NSRegularExpression(pattern: #"\bevery\s+\d+\s+(hours?|minutes?)\b"#, options: .caseInsensitive)
        let freqMatches = freqRegex.matches(in: lower, range: NSRange(lower.startIndex..., in: lower))
        for match in freqMatches {
            if let range = Range(match.range, in: lower) {
                parts.append(String(lower[range]))
            }
        }

        let freqKeywords = ["hourly", "periodically"]
        for keyword in freqKeywords where lower.contains(keyword) {
            parts.append(keyword)
        }

        return parts.isEmpty ? "on demand" : parts.joined(separator: ", ")
    }
}
