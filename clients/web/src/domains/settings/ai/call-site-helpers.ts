import type { ParseKeys, TFunction } from "@/i18n";
import type {
  CallSiteOverrideDraft,
  ConfigLlmCallsitesGetResponse,
} from "@/generated/daemon/types.gen";

// ---------------------------------------------------------------------------
// Sentinel value for the "Custom" profile picker option
// ---------------------------------------------------------------------------

export const CUSTOM_SENTINEL = "__custom__";

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Localization helpers
// ---------------------------------------------------------------------------

export const CALL_SITE_I18N_MAP = {
  domains: {
    agentLoop: "callSiteCatalog.domains.agentLoop",
    memory: "callSiteCatalog.domains.memory",
    workspace: "callSiteCatalog.domains.workspace",
    ui: "callSiteCatalog.domains.ui",
    notifications: "callSiteCatalog.domains.notifications",
    skills: "callSiteCatalog.domains.skills",
  },
  sites: {
    mainAgent: {
      displayName: "callSiteCatalog.sites.mainAgent.displayName",
      description: "callSiteCatalog.sites.mainAgent.description",
    },
    subagentSpawn: {
      displayName: "callSiteCatalog.sites.subagentSpawn.displayName",
      description: "callSiteCatalog.sites.subagentSpawn.description",
    },
    heartbeatAgent: {
      displayName: "callSiteCatalog.sites.heartbeatAgent.displayName",
      description: "callSiteCatalog.sites.heartbeatAgent.description",
    },
    filingAgent: {
      displayName: "callSiteCatalog.sites.filingAgent.displayName",
      description: "callSiteCatalog.sites.filingAgent.description",
    },
    compactionAgent: {
      displayName: "callSiteCatalog.sites.compactionAgent.displayName",
      description: "callSiteCatalog.sites.compactionAgent.description",
    },
    callAgent: {
      displayName: "callSiteCatalog.sites.callAgent.displayName",
      description: "callSiteCatalog.sites.callAgent.description",
    },
    workflowLeaf: {
      displayName: "callSiteCatalog.sites.workflowLeaf.displayName",
      description: "callSiteCatalog.sites.workflowLeaf.description",
    },
    voiceProgressNarration: {
      displayName: "callSiteCatalog.sites.voiceProgressNarration.displayName",
      description: "callSiteCatalog.sites.voiceProgressNarration.description",
    },
    voiceFrontDoor: {
      displayName: "callSiteCatalog.sites.voiceFrontDoor.displayName",
      description: "callSiteCatalog.sites.voiceFrontDoor.description",
    },
    memoryExtraction: {
      displayName: "callSiteCatalog.sites.memoryExtraction.displayName",
      description: "callSiteCatalog.sites.memoryExtraction.description",
    },
    memoryConsolidation: {
      displayName: "callSiteCatalog.sites.memoryConsolidation.displayName",
      description: "callSiteCatalog.sites.memoryConsolidation.description",
    },
    memoryRetrieval: {
      displayName: "callSiteCatalog.sites.memoryRetrieval.displayName",
      description: "callSiteCatalog.sites.memoryRetrieval.description",
    },
    memoryV2Migration: {
      displayName: "callSiteCatalog.sites.memoryV2Migration.displayName",
      description: "callSiteCatalog.sites.memoryV2Migration.description",
    },
    memoryV2Sweep: {
      displayName: "callSiteCatalog.sites.memoryV2Sweep.displayName",
      description: "callSiteCatalog.sites.memoryV2Sweep.description",
    },
    memoryRouter: {
      displayName: "callSiteCatalog.sites.memoryRouter.displayName",
      description: "callSiteCatalog.sites.memoryRouter.description",
    },
    memoryV3SelectL2: {
      displayName: "callSiteCatalog.sites.memoryV3SelectL2.displayName",
      description: "callSiteCatalog.sites.memoryV3SelectL2.description",
    },
    memoryV2Consolidation: {
      displayName: "callSiteCatalog.sites.memoryV2Consolidation.displayName",
      description: "callSiteCatalog.sites.memoryV2Consolidation.description",
    },
    memoryRetrospective: {
      displayName: "callSiteCatalog.sites.memoryRetrospective.displayName",
      description: "callSiteCatalog.sites.memoryRetrospective.description",
    },
    recall: {
      displayName: "callSiteCatalog.sites.recall.displayName",
      description: "callSiteCatalog.sites.recall.description",
    },
    narrativeRefinement: {
      displayName: "callSiteCatalog.sites.narrativeRefinement.displayName",
      description: "callSiteCatalog.sites.narrativeRefinement.description",
    },
    patternScan: {
      displayName: "callSiteCatalog.sites.patternScan.displayName",
      description: "callSiteCatalog.sites.patternScan.description",
    },
    conversationSummarization: {
      displayName: "callSiteCatalog.sites.conversationSummarization.displayName",
      description: "callSiteCatalog.sites.conversationSummarization.description",
    },
    commitMessage: {
      displayName: "callSiteCatalog.sites.commitMessage.displayName",
      description: "callSiteCatalog.sites.commitMessage.description",
    },
    conversationStarters: {
      displayName: "callSiteCatalog.sites.conversationStarters.displayName",
      description: "callSiteCatalog.sites.conversationStarters.description",
    },
    replySuggestion: {
      displayName: "callSiteCatalog.sites.replySuggestion.displayName",
      description: "callSiteCatalog.sites.replySuggestion.description",
    },
    conversationTitle: {
      displayName: "callSiteCatalog.sites.conversationTitle.displayName",
      description: "callSiteCatalog.sites.conversationTitle.description",
    },
    identityIntro: {
      displayName: "callSiteCatalog.sites.identityIntro.displayName",
      description: "callSiteCatalog.sites.identityIntro.description",
    },
    emptyStateGreeting: {
      displayName: "callSiteCatalog.sites.emptyStateGreeting.displayName",
      description: "callSiteCatalog.sites.emptyStateGreeting.description",
    },
    guardianQuestionCopy: {
      displayName: "callSiteCatalog.sites.guardianQuestionCopy.displayName",
      description: "callSiteCatalog.sites.guardianQuestionCopy.description",
    },
    approvalCopy: {
      displayName: "callSiteCatalog.sites.approvalCopy.displayName",
      description: "callSiteCatalog.sites.approvalCopy.description",
    },
    approvalConversation: {
      displayName: "callSiteCatalog.sites.approvalConversation.displayName",
      description: "callSiteCatalog.sites.approvalConversation.description",
    },
    trustRuleSuggestion: {
      displayName: "callSiteCatalog.sites.trustRuleSuggestion.displayName",
      description: "callSiteCatalog.sites.trustRuleSuggestion.description",
    },
    homeGreeting: {
      displayName: "callSiteCatalog.sites.homeGreeting.displayName",
      description: "callSiteCatalog.sites.homeGreeting.description",
    },
    homeSuggestedPrompts: {
      displayName: "callSiteCatalog.sites.homeSuggestedPrompts.displayName",
      description: "callSiteCatalog.sites.homeSuggestedPrompts.description",
    },
    notificationDecision: {
      displayName: "callSiteCatalog.sites.notificationDecision.displayName",
      description: "callSiteCatalog.sites.notificationDecision.description",
    },
    preferenceExtraction: {
      displayName: "callSiteCatalog.sites.preferenceExtraction.displayName",
      description: "callSiteCatalog.sites.preferenceExtraction.description",
    },
    interactionClassifier: {
      displayName: "callSiteCatalog.sites.interactionClassifier.displayName",
      description: "callSiteCatalog.sites.interactionClassifier.description",
    },
    styleAnalyzer: {
      displayName: "callSiteCatalog.sites.styleAnalyzer.displayName",
      description: "callSiteCatalog.sites.styleAnalyzer.description",
    },
    inviteInstructionGenerator: {
      displayName: "callSiteCatalog.sites.inviteInstructionGenerator.displayName",
      description: "callSiteCatalog.sites.inviteInstructionGenerator.description",
    },
    skillCategoryInference: {
      displayName: "callSiteCatalog.sites.skillCategoryInference.displayName",
      description: "callSiteCatalog.sites.skillCategoryInference.description",
    },
    inference: {
      displayName: "callSiteCatalog.sites.inference.displayName",
      description: "callSiteCatalog.sites.inference.description",
    },
    vision: {
      displayName: "callSiteCatalog.sites.vision.displayName",
      description: "callSiteCatalog.sites.vision.description",
    },
  },
} as const;

export function getCallSiteDisplayName(
  id: string,
  rawDisplayName: string,
  t: TFunction<"settings">,
): string {
  const key =
    CALL_SITE_I18N_MAP.sites[id as keyof typeof CALL_SITE_I18N_MAP.sites]
      ?.displayName;
  if (key) {
    return t(key as ParseKeys<"settings">, { defaultValue: rawDisplayName });
  }
  return rawDisplayName;
}

export function getCallSiteDescription(
  id: string,
  rawDescription: string | undefined,
  t: TFunction<"settings">,
): string | undefined {
  if (!rawDescription) {
    return undefined;
  }
  const key =
    CALL_SITE_I18N_MAP.sites[id as keyof typeof CALL_SITE_I18N_MAP.sites]
      ?.description;
  if (key) {
    return t(key as ParseKeys<"settings">, { defaultValue: rawDescription });
  }
  return rawDescription;
}

export function getDomainDisplayName(
  id: string,
  rawDisplayName: string,
  t: TFunction<"settings">,
): string {
  const key =
    CALL_SITE_I18N_MAP.domains[id as keyof typeof CALL_SITE_I18N_MAP.domains];
  if (key) {
    return t(key as ParseKeys<"settings">, { defaultValue: rawDisplayName });
  }
  return rawDisplayName;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isDraftActive(
  d: CallSiteOverrideDraft | null | undefined,
): boolean {
  if (!d) {
    return false;
  }
  return !!(d.profile || d.provider || d.model);
}

/**
 * The profile a call site currently runs on, and how it got there.
 *
 * The authority is the catalog's `defaultProfile`, which is the daemon's own
 * winning profile for the call site: pins included, and rungs the resolver
 * cannot use already skipped. Reading the raw override instead would report
 * a pin that names a disabled or incomplete profile as the current
 * selection, when the resolver skips it and the action runs on something
 * else entirely.
 *
 * `via` is therefore derived by asking whether the winner is the pin, rather
 * than assuming a pin wins. Returns null for provider/model ("Custom") pins,
 * which reference no profile at all.
 */
export interface CallSiteEffectiveProfile {
  profile: string;
  via: "override" | "default";
}

/** The catalog fields naming which profile a call site resolves to. */
type CallSiteDefaults = Pick<
  ConfigLlmCallsitesGetResponse["callSites"][number],
  "defaultProfile" | "shippedDefaultProfile"
>;

export function effectiveCallSiteProfile(
  callSite: CallSiteDefaults,
  override: CallSiteOverrideDraft | null | undefined,
): CallSiteEffectiveProfile | null {
  if (override?.provider || override?.model) {
    return null;
  }
  // `shippedDefaultProfile` covers the profileless case, where the winner is
  // the code-owned anchor rather than a named profile and `defaultProfile`
  // is absent. It matches what the row caption shows for those sites.
  const winner = callSite.defaultProfile ?? callSite.shippedDefaultProfile;
  if (!winner) {
    return null;
  }
  return {
    profile: winner,
    via: override?.profile === winner ? "override" : "default",
  };
}

export function draftsEqual(
  a: CallSiteOverrideDraft | null | undefined,
  b: CallSiteOverrideDraft | null | undefined,
): boolean {
  const aActive = isDraftActive(a);
  const bActive = isDraftActive(b);
  if (aActive !== bActive) {
    return false;
  }
  if (!aActive) {
    return true;
  }
  return (
    (a?.profile ?? null) === (b?.profile ?? null) &&
    (a?.provider ?? null) === (b?.provider ?? null) &&
    (a?.model ?? null) === (b?.model ?? null)
  );
}
