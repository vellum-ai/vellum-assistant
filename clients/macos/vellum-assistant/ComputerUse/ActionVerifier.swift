import Foundation
import CoreGraphics

enum VerifyResult {
    case allowed
    case needsConfirmation(String)
    case blocked(String)
}

final class ActionVerifier {
    private var actionHistory: [AgentAction] = []
    private let maxSteps: Int
    private(set) var blockedCount: Int = 0

    init(maxSteps: Int = 50) {
        self.maxSteps = maxSteps
    }

    func verify(_ action: AgentAction) -> VerifyResult {
        // 1. Step limit
        if actionHistory.count >= maxSteps {
            return .blocked("Maximum step limit (\(maxSteps)) reached")
        }

        // 2. Loop detection — same action 3 times consecutively
        if actionHistory.count >= 2 {
            let last2 = Array(actionHistory.suffix(2))
            if last2.allSatisfy({ actionsAreIdentical($0, action) }) {
                return .blocked("Agent appears stuck — same action repeated 3 times consecutively")
            }
        }

        // 3. Sensitive text detection
        if let text = action.text {
            if looksLikeCreditCard(text) {
                return .blocked("Blocked: text appears to contain a credit card number")
            }
            if looksLikeSSN(text) {
                return .blocked("Blocked: text appears to contain a Social Security Number")
            }
            if looksLikePassword(text) {
                return .blocked("Blocked: text appears to contain a password")
            }
        }

        // 4. Destructive key combos
        if action.type == .key, let key = action.key?.lowercased() {
            let destructiveKeys = ["cmd+q", "command+q", "cmd+w", "command+w",
                                   "cmd+delete", "command+delete", "cmd+backspace", "command+backspace"]
            if destructiveKeys.contains(key) {
                return .needsConfirmation("Key combo '\(key)' could close a window or delete content")
            }
        }

        // 5. Form submission (Enter after typing)
        if action.type == .key, let key = action.key?.lowercased(),
           (key == "enter" || key == "return"),
           let lastAction = actionHistory.last, lastAction.type == .type {
            return .needsConfirmation("Pressing Enter may submit a form")
        }

        // 6. Forbidden screen region (system menu bar)
        if let y = action.y, y < 25, action.type == .click || action.type == .doubleClick || action.type == .rightClick {
            return .blocked("Action targets the system menu bar (y < 25)")
        }

        // All checks passed
        actionHistory.append(action)
        return .allowed
    }

    func reset() {
        actionHistory.removeAll()
        blockedCount = 0
    }

    var currentStepCount: Int { actionHistory.count }

    var consecutiveBlockCount: Int { blockedCount }

    func recordBlock() { blockedCount += 1 }

    func resetBlockCount() { blockedCount = 0 }

    // MARK: - Comparison

    private func actionsAreIdentical(_ a: AgentAction, _ b: AgentAction) -> Bool {
        a.type == b.type && a.x == b.x && a.y == b.y && a.text == b.text && a.key == b.key
    }

    // MARK: - Sensitive Data Detection

    private func looksLikeCreditCard(_ text: String) -> Bool {
        let stripped = text.replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
        guard stripped.count >= 13 && stripped.count <= 19 else { return false }
        return stripped.allSatisfy(\.isNumber)
    }

    private func looksLikeSSN(_ text: String) -> Bool {
        let pattern = #"^\d{3}-?\d{2}-?\d{4}$"#
        return text.range(of: pattern, options: .regularExpression) != nil
    }

    private func looksLikePassword(_ text: String) -> Bool {
        guard text.count >= 8 && text.count <= 64 else { return false }
        let hasUpper = text.contains(where: \.isUppercase)
        let hasLower = text.contains(where: \.isLowercase)
        let hasDigit = text.contains(where: \.isNumber)
        let symbols = CharacterSet.alphanumerics.inverted
        let hasSymbol = text.unicodeScalars.contains(where: { symbols.contains($0) })
        return hasUpper && hasLower && hasDigit && hasSymbol
    }
}
