# V3 Trust Rules: Wire Rule Creation from Permission Prompt + Trust Rules Manager UI

## Overview
Combined Phase 3+4 of the V3 Trust Rules project. Wires the SwiftUI macOS client to the v3 trust rules backend (added in Phase 2, PR #27900). Two parts: (1) rewire V3RuleEditorModal save to POST to the gateway's `/v1/trust-rules-v3` endpoint instead of the v1 trust store, and (2) build a V3TrustRulesView (Trust Rules Manager) accessible from Settings > Privacy & Permissions. All new behavior gated behind `permission-controls-v3` feature flag — existing v1 flows untouched when the flag is off.

## PR 1: Add TrustRuleV3 model and TrustRuleV3Client
### Depends on
None

### Branch
v3-trust-rules-client/pr-1-v3-client

### Title
feat(clients): add TrustRuleV3 model and TrustRuleV3Client for v3 trust rules API

### Files
- clients/shared/Network/TrustRuleV3Client.swift

### Implementation steps
1. Create `clients/shared/Network/TrustRuleV3Client.swift` with:

   - A `TrustRuleV3` response model struct:
     ```swift
     public struct TrustRuleV3: Codable, Identifiable, Sendable {
         public let id: String
         public let tool: String
         public let pattern: String
         public var risk: String
         public let description: String
         public let origin: String
         public let userModified: Bool
         public let deleted: Bool
         public let createdAt: String
         public let updatedAt: String
     }
     ```

   - A private response wrapper:
     ```swift
     private struct TrustRuleV3ListResponse: Decodable {
         let rules: [TrustRuleV3]
     }
     ```

   - A `TrustRuleV3ClientError` enum:
     ```swift
     public enum TrustRuleV3ClientError: Error, LocalizedError {
         case requestFailed(Int)
         case notFound
         case featureDisabled

         public var errorDescription: String? {
             switch self {
             case .requestFailed(let code): return "Trust rule v3 request failed (HTTP \(code))"
             case .notFound: return "Trust rule not found"
             case .featureDisabled: return "Feature not enabled"
             }
         }
     }
     ```

   - A `TrustRuleV3ClientProtocol` protocol:
     ```swift
     public protocol TrustRuleV3ClientProtocol {
         func listRules(origin: String?, tool: String?, includeDeleted: Bool?) async throws -> [TrustRuleV3]
         func createRule(tool: String, pattern: String, risk: String, description: String) async throws -> TrustRuleV3
         func updateRule(id: String, risk: String?, description: String?) async throws -> TrustRuleV3
         func deleteRule(id: String) async throws
         func resetRule(id: String) async throws -> TrustRuleV3
     }
     ```

   - A `TrustRuleV3Client` struct implementing the protocol. Follow the same pattern as `ThresholdClient` (see `clients/shared/Network/ThresholdClient.swift`):
     - `nonisolated public init() {}`
     - Base path: `"trust-rules-v3"` (GatewayHTTPClient prepends `/v1/`)
     - `listRules(origin:tool:includeDeleted:)`: GET with query params. Build params dict from non-nil arguments. Decode response as `TrustRuleV3ListResponse`. Return `.rules`.
     - `createRule(tool:pattern:risk:description:)`: POST with JSON body `{ tool, pattern, risk, description }`. Decode response wrapping `{ rule: TrustRuleV3 }`. Return the rule. Handle 403 as `.featureDisabled`.
     - `updateRule(id:risk:description:)`: PATCH `trust-rules-v3/{id}` with JSON body (only include non-nil fields). Decode response wrapping `{ rule: TrustRuleV3 }`. Handle 404 as `.notFound`. Handle 403 as `.featureDisabled`.
     - `deleteRule(id:)`: DELETE `trust-rules-v3/{id}`. Handle 404 as `.notFound`. Handle 403 as `.featureDisabled`.
     - `resetRule(id:)`: POST `trust-rules-v3/{id}/reset`. Decode response wrapping `{ rule: TrustRuleV3 }`. Handle 404 as `.notFound`. Handle 403 as `.featureDisabled`.
     - Percent-encode the `id` in URL paths using `addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)` (IDs like `default:bash:git-push` contain colons).
     - Use `os.Logger` with subsystem `Bundle.appBundleIdentifier` and category `"TrustRuleV3Client"`.
     - Timeout: 10 seconds for all operations (matches v1 TrustRuleClient).

### Acceptance criteria
- `TrustRuleV3` struct is Codable, Identifiable, Sendable
- `TrustRuleV3ClientProtocol` defines all 5 CRUD methods
- `TrustRuleV3Client` implements the protocol using GatewayHTTPClient
- All paths use `"trust-rules-v3"` base (no `assistants/{assistantId}/` prefix — this is a gateway-owned endpoint)
- Error handling: 403 → featureDisabled, 404 → notFound, other non-2xx → requestFailed
- IDs are percent-encoded in URL paths

## PR 2: Rewire V3RuleEditorModal save to v3 trust rules API
### Depends on
PR 1

### Branch
v3-trust-rules-client/pr-2-modal-rewire

### Title
feat(clients): rewire V3RuleEditorModal save to v3 trust rules API

### Files
- clients/macos/vellum-assistant/Features/Chat/AssistantProgressView.swift

### Implementation steps
1. In `clients/macos/vellum-assistant/Features/Chat/AssistantProgressView.swift`:
   - Add a static property for the v3 client alongside the existing v1 client:
     ```swift
     private static let trustRuleV3Client = TrustRuleV3Client()
     ```
   - Find the V3RuleEditorModal `onSave` closure (around line 846-856). Currently it calls:
     ```swift
     try? await Self.trustRuleClient.addTrustRule(
         toolName: rule.toolName,
         pattern: rule.pattern,
         scope: rule.scope,
         decision: "allow",
         executionTarget: nil,
         riskLevel: rule.riskLevel
     )
     ```
   - Replace with a call to the v3 client. The v3 API takes `tool`, `pattern`, `risk`, and `description`. The description can be generated from the tool call context:
     ```swift
     onSave: { rule in
         Task {
             try? await Self.trustRuleV3Client.createRule(
                 tool: rule.toolName,
                 pattern: rule.pattern,
                 risk: rule.riskLevel,
                 description: tc.reasonDescription ?? "\(rule.toolName) — \(rule.pattern)"
             )
         }
     },
     ```
   - The v1 `addTrustRule` call in the `else` branch (RuleEditorModal for when v3 flag is off) stays untouched.

### Acceptance criteria
- When `permission-controls-v3` is enabled, saving from V3RuleEditorModal calls `TrustRuleV3Client.createRule()` instead of `TrustRuleClient.addTrustRule()`
- The v3 call sends tool, pattern, risk, and a description
- When `permission-controls-v3` is disabled, the existing v1 `addTrustRule()` path is used unchanged
- The rule is persisted to the `trust_rules` SQLite table (verified by the gateway)
- The classifier picks up the new rule immediately (cache invalidation is built into the gateway's POST handler)

## PR 3: Build V3TrustRulesView trust rules manager
### Depends on
PR 1

### Branch
v3-trust-rules-client/pr-3-manager-view

### Title
feat(clients): add V3TrustRulesView trust rules manager

### Files
- clients/macos/vellum-assistant/Features/Settings/V3TrustRulesView.swift

### Implementation steps
1. Create `clients/macos/vellum-assistant/Features/Settings/V3TrustRulesView.swift`:

   - Import Foundation, SwiftUI, os.

   - **V3TrustRulesView** struct:
     - Takes `trustRuleV3Client: TrustRuleV3ClientProtocol` (protocol for testability).
     - `@Environment(\.dismiss) private var dismiss`
     - State:
       ```swift
       @State private var rules: [TrustRuleV3] = []
       @State private var isLoading = true
       @State private var showAllDefaults = false
       @State private var editingRule: TrustRuleV3? = nil
       @State private var ruleToDelete: TrustRuleV3? = nil
       ```
     - Body:
       - VStack with header, content, and footer.
       - **Header**: "Trust Rules" title (VFont.titleSmall), Toggle "Show all defaults" (small toggle), "Done" button.
       - **Content**: ScrollView with LazyVStack of `V3TrustRuleRow` for each rule.
       - **Empty state**: When `rules.isEmpty && !isLoading`, show a shield icon and "No trust rules yet. Rules are created when you classify actions from permission prompts."
       - **Loading**: `ProgressView()` when `isLoading`.
     - `loadRules()`:
       - If `showAllDefaults` is true, call `trustRuleV3Client.listRules(origin: "default", tool: nil, includeDeleted: nil)` to get all defaults, PLUS `trustRuleV3Client.listRules(origin: nil, tool: nil, includeDeleted: nil)` for user-relevant rules. Merge and deduplicate by id.
       - If `showAllDefaults` is false (default), call `trustRuleV3Client.listRules(origin: nil, tool: nil, includeDeleted: nil)` which returns only user-defined + user-modified defaults.
       - Sort by `tool` then `description`.
     - `.task { await loadRules() }` and `.onChange(of: showAllDefaults) { await loadRules() }`
     - `.sheet(item: $editingRule)` presents `V3TrustRuleEditSheet`.
     - `.alert` for delete confirmation.

   - **V3TrustRuleRow** (private struct):
     - Takes `rule: TrustRuleV3`, `onEdit: () -> Void`, `onDelete: () -> Void`.
     - HStack layout:
       - VStack(leading): description (VFont.bodyMedium), tool name (VFont.caption, VColor.contentTertiary).
       - Spacer.
       - Risk badge: Text capsule with colors: "low" → green, "medium" → yellow, "high" → red. Use VColor equivalents.
       - If `rule.origin == "default"`: small "Default" text badge (VColor.contentTertiary).
       - If `rule.userModified`: small "Modified" text badge.
       - Edit button (pencil icon) → `onEdit()`.
       - Delete button (trash icon) → `onDelete()`.
     - Tap gesture → `onEdit()`.

   - **V3TrustRuleEditSheet** (private struct):
     - Takes `rule: TrustRuleV3`, `trustRuleV3Client: TrustRuleV3ClientProtocol`, `onSave: () async -> Void`.
     - `@Environment(\.dismiss) private var dismiss`
     - State: `@State private var selectedRisk: String`, `@State private var isSaving = false`.
     - Initialize `selectedRisk` from `rule.risk` in `.onAppear`.
     - Body:
       - VStack with padding.
       - **Pattern**: `rule.pattern` (read-only text, VFont.bodyMedium).
       - **Description**: `rule.description` (read-only text, VFont.caption).
       - **Risk level picker**: 3 capsule buttons (Low green, Medium yellow, High red) — same style as V3RuleEditorModal's risk picker. The selected one is filled, others are outlined.
       - **Reset to Default** button: only shown when `rule.origin == "default" && rule.userModified`. Calls `trustRuleV3Client.resetRule(id: rule.id)`, then `onSave()`, then `dismiss()`.
       - **Save** button: calls `trustRuleV3Client.updateRule(id: rule.id, risk: selectedRisk, description: nil)`, then `onSave()`, then `dismiss()`. Disabled when `selectedRisk == rule.risk`.
       - **Cancel** button: `dismiss()`.
     - Frame: 400 width, fits content height.

   - **deleteRule(rule:)** method on V3TrustRulesView:
     - Calls `trustRuleV3Client.deleteRule(id: rule.id)`.
     - Removes the rule from `rules` with animation.
     - Logs errors but doesn't show alerts (matches v1 TrustRulesView pattern).

   - Frame: `.frame(width: 600, minHeight: 500)` (matches v1 TrustRulesView).

### Acceptance criteria
- V3TrustRulesView shows user-defined rules and user-modified defaults by default
- "Show all defaults" toggle reveals all seeded defaults
- Each row shows description, tool, risk badge (colored), origin badge, modified indicator
- Tapping a row opens V3TrustRuleEditSheet
- Edit sheet allows changing risk level via capsule picker
- Save calls PATCH /v1/trust-rules-v3/:id
- Reset to Default calls POST /v1/trust-rules-v3/:id/reset (only for modified defaults)
- Delete works (confirmation alert, then DELETE /v1/trust-rules-v3/:id)
- Empty state shown when no rules exist
- Loading state shown while fetching

## PR 4: Wire V3TrustRulesView into SettingsPanel
### Depends on
PR 3

### Branch
v3-trust-rules-client/pr-4-settings-wirein

### Title
feat(clients): wire V3TrustRulesView into Settings panel

### Files
- clients/macos/vellum-assistant/Features/MainWindow/Panels/SettingsPanel.swift

### Implementation steps
1. In `clients/macos/vellum-assistant/Features/MainWindow/Panels/SettingsPanel.swift`:
   - Find the `.sheet(isPresented: $showingTrustRules)` modifier (around the trust rules section in `permissionsAndPrivacyContent`).
   - Currently it unconditionally presents:
     ```swift
     .sheet(isPresented: $showingTrustRules, onDismiss: { connectionManager?.isTrustRulesSheetOpen = false }) {
         TrustRulesView(trustRuleClient: TrustRuleClient())
     }
     ```
   - Change to conditionally present V3TrustRulesView when the flag is on:
     ```swift
     .sheet(isPresented: $showingTrustRules, onDismiss: { connectionManager?.isTrustRulesSheetOpen = false }) {
         if assistantFeatureFlagStore.isEnabled("permission-controls-v3") {
             V3TrustRulesView(trustRuleV3Client: TrustRuleV3Client())
         } else {
             TrustRulesView(trustRuleClient: TrustRuleClient())
         }
     }
     ```
   - The `assistantFeatureFlagStore` is already available as a property on SettingsPanel (it's used in SettingsPrivacyTab).

### Acceptance criteria
- When `permission-controls-v3` is enabled, "Manage" button in Settings > Privacy & Permissions opens V3TrustRulesView
- When `permission-controls-v3` is disabled, "Manage" button opens the existing v1 TrustRulesView
- No changes to the v1 TrustRulesView or its behavior
- The feature flag check uses `assistantFeatureFlagStore.isEnabled("permission-controls-v3")` consistent with other v3 flag checks in the codebase
