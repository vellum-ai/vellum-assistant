import Foundation

/// Lightweight representation of the user profile stored in UserDefaults
/// under the `"user.profile"` key. Originally populated by the onboarding
/// interview's profile-extraction step.
struct UserProfile: Codable, Sendable {
    let name: String?
    let role: String?
    let goals: [String]?
    let painPoints: [String]?
    let communicationStyle: String?
    let interests: [String]?
    let personality: String?
}
