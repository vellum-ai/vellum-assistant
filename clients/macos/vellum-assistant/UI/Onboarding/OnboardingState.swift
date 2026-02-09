import SwiftUI

enum OrbMood {
    case dormant
    case breathing
    case listening
    case celebrating
}

enum ActivationKey: String {
    case fn
    case globe
    case ctrl

    var displayName: String {
        switch self {
        case .fn, .globe: return "fn"
        case .ctrl: return "ctrl"
        }
    }
}

enum Integration: String, CaseIterable, Identifiable {
    case github = "GitHub"
    case gmail = "Gmail"
    case slack = "Slack"
    case linear = "Linear"
    case notion = "Notion"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .github: return "chevron.left.forwardslash.chevron.right"
        case .gmail: return "envelope.fill"
        case .slack: return "number"
        case .linear: return "list.bullet.rectangle"
        case .notion: return "doc.text.fill"
        }
    }

    var recipeName: String? {
        switch self {
        case .github: return "github-app-setup"
        case .gmail, .slack, .linear, .notion: return nil // future
        }
    }
}

enum RecipeExecutionState: Equatable {
    case idle
    case running(step: Int, total: Int, description: String)
    case completed(integration: Integration)
    case failed(reason: String)
}

@Observable
@MainActor
final class OnboardingState {
    var currentStep: Int = 0
    var assistantName: String = ""
    var chosenKey: ActivationKey = .fn
    var orbMood: OrbMood = .dormant
    var micGranted: Bool = false
    var screenGranted: Bool = false
    var skipPermissionChecks: Bool = false
    var selectedIntegration: Integration?
    var recipeState: RecipeExecutionState = .idle

    func advance() {
        withAnimation(.easeOut(duration: 0.8)) {
            currentStep += 1
        }
    }
}
