import { describe, expect, test } from "bun:test";

import { ONBOARDING_FUNNEL_STEPS } from "@/domains/onboarding/funnel-events";
import {
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  type PreChatStepId,
  type WebStepCapabilities,
} from "@/domains/onboarding/prechat-steps";

const CONTROL: WebStepCapabilities = {
  paredDown: false,
  canOfferPriorAssistants: true,
  canOfferGoogleStep: true,
  hasGoogleTool: true,
  showIOSAppStep: true,
};

function ids(caps: WebStepCapabilities): PreChatStepId[] {
  return resolveWebSteps(caps).map((step) => step.id);
}

describe("resolveWebSteps", () => {
  test("full control funnel: every capability enabled", () => {
    expect(ids(CONTROL)).toEqual([
      "name",
      "taskTone",
      "tools",
      "priorAssistants",
      "google",
      "iosApp",
    ]);
  });

  test("local mode with no platform session drops platform-gated steps", () => {
    // canOfferPriorAssistants false (no platform account) and no Google tool
    // picked → the flow collapses to the always-on steps.
    expect(
      ids({
        ...CONTROL,
        canOfferPriorAssistants: false,
        hasGoogleTool: false,
        showIOSAppStep: false,
      }),
    ).toEqual(["name", "taskTone", "tools"]);
  });

  test("local mode without a session still offers google for a cached assistant", () => {
    // canOfferGoogleStep stays true when a platform assistant id is cached
    // (e.g. a prior managed session), so a local user who picks a Google tool
    // reaches the connect step even though prior-assistants is gated off. Back
    // from google therefore lands on tools, never on the gated step.
    const steps = resolveWebSteps({
      ...CONTROL,
      canOfferPriorAssistants: false,
      hasGoogleTool: true,
      canOfferGoogleStep: true,
      showIOSAppStep: false,
    });
    expect(steps.map((s) => s.id)).toEqual([
      "name",
      "taskTone",
      "tools",
      "google",
    ]);
    expect(prevStep(steps, "google")).toBe("tools");
  });

  test("local mode with a platform session keeps prior-assistants", () => {
    expect(
      ids({
        ...CONTROL,
        hasGoogleTool: false,
        showIOSAppStep: false,
      }),
    ).toEqual(["name", "taskTone", "tools", "priorAssistants"]);
  });

  test("google step only appears when a Google tool was picked", () => {
    expect(ids({ ...CONTROL, hasGoogleTool: false })).not.toContain("google");
    expect(ids({ ...CONTROL, hasGoogleTool: true })).toContain("google");
  });

  test("google step is suppressed when the step is unavailable", () => {
    expect(ids({ ...CONTROL, canOfferGoogleStep: false })).not.toContain(
      "google",
    );
  });

  test("iOS app step only on iOS web", () => {
    expect(ids({ ...CONTROL, showIOSAppStep: false })).not.toContain("iosApp");
  });

  test("pared-down funnel: name then google only", () => {
    expect(
      ids({
        paredDown: true,
        canOfferPriorAssistants: true,
        canOfferGoogleStep: true,
        hasGoogleTool: false,
        showIOSAppStep: true,
      }),
    ).toEqual(["name", "google"]);
  });

  test("pared-down funnel offers google without a tool selection", () => {
    // No tool-selection screen in this variant, so hasGoogleTool is irrelevant.
    expect(
      ids({
        paredDown: true,
        canOfferPriorAssistants: true,
        canOfferGoogleStep: true,
        hasGoogleTool: false,
        showIOSAppStep: false,
      }),
    ).toEqual(["name", "google"]);
  });

  test("pared-down funnel collapses to name when google is unavailable", () => {
    expect(
      ids({
        paredDown: true,
        canOfferPriorAssistants: true,
        canOfferGoogleStep: false,
        hasGoogleTool: true,
        showIOSAppStep: true,
      }),
    ).toEqual(["name"]);
  });

  test("emits the variant-specific google funnel event", () => {
    const control = resolveWebSteps(CONTROL).find((s) => s.id === "google");
    expect(control?.funnelStep).toBe(
      ONBOARDING_FUNNEL_STEPS.controlGmailConnect,
    );
    const pared = resolveWebSteps({
      paredDown: true,
      canOfferPriorAssistants: true,
      canOfferGoogleStep: true,
      hasGoogleTool: false,
      showIOSAppStep: false,
    }).find((s) => s.id === "google");
    expect(pared?.funnelStep).toBe(ONBOARDING_FUNNEL_STEPS.gmailConnect);
  });
});

describe("resolveNativeSteps", () => {
  test("name then vibe, not funnel-instrumented", () => {
    const steps = resolveNativeSteps();
    expect(steps.map((s) => s.id)).toEqual(["nativeName", "nativeVibe"]);
    expect(steps.every((s) => s.funnelStep === null)).toBe(true);
  });
});

describe("nextStep / prevStep", () => {
  test("walk forward through the full control funnel", () => {
    const steps = resolveWebSteps(CONTROL);
    expect(nextStep(steps, "name")).toBe("taskTone");
    expect(nextStep(steps, "tools")).toBe("priorAssistants");
    expect(nextStep(steps, "google")).toBe("iosApp");
    expect(nextStep(steps, "iosApp")).toBeNull();
  });

  test("back never reveals a gated step: skips disabled prior-assistants", () => {
    // No platform session → prior-assistants is gated out, so back from google
    // lands on tools, never on the disabled prior-assistants step.
    const steps = resolveWebSteps({ ...CONTROL, canOfferPriorAssistants: false });
    expect(prevStep(steps, "google")).toBe("tools");
  });

  test("back from google lands on prior-assistants when it is enabled", () => {
    const steps = resolveWebSteps(CONTROL);
    expect(prevStep(steps, "google")).toBe("priorAssistants");
  });

  test("prev from the first step is null", () => {
    const steps = resolveWebSteps(CONTROL);
    expect(prevStep(steps, "name")).toBeNull();
  });

  test("a step that is not in the resolved list resolves to null", () => {
    const steps = resolveWebSteps({ ...CONTROL, hasGoogleTool: false });
    expect(nextStep(steps, "google")).toBeNull();
    expect(prevStep(steps, "google")).toBeNull();
  });
});
