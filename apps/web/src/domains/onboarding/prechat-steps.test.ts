import { describe, expect, test } from "bun:test";

import { ONBOARDING_FUNNEL_STEPS } from "@/domains/onboarding/funnel-events";
import {
  isPlatformFunnelAvailable,
  nextStep,
  prevStep,
  resolveNativeSteps,
  resolveWebSteps,
  restoreNativeStep,
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

  test("platform-gated steps move together when the funnel is unavailable", () => {
    // canOfferPriorAssistants and canOfferGoogleStep share one gate (a live
    // platform session). A local user with no session — even one carrying a
    // stale cached platform assistant id — reaches neither step, so picking a
    // Google tool no longer surfaces the connect screen.
    expect(
      ids({
        ...CONTROL,
        canOfferPriorAssistants: false,
        canOfferGoogleStep: false,
        hasGoogleTool: true,
        showIOSAppStep: false,
      }),
    ).toEqual(["name", "taskTone", "tools"]);
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
    const steps = resolveWebSteps({
      paredDown: true,
      canOfferPriorAssistants: true,
      canOfferGoogleStep: true,
      hasGoogleTool: false,
      showIOSAppStep: true,
    });
    expect(steps.map((s) => s.id)).toEqual(["name", "google"]);
    // Back from google skips every gated control step and lands on name.
    expect(prevStep(steps, "google")).toBe("name");
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

describe("restoreNativeStep", () => {
  test("restores the vibe step from the current persisted value", () => {
    expect(restoreNativeStep("nativeVibe")).toBe("nativeVibe");
  });

  test("restores the vibe step from the legacy numeric value", () => {
    // An older build persisted the raw screen index; a user who updated the
    // app mid-onboarding must still land on the vibe step, not the start.
    expect(restoreNativeStep("1")).toBe("nativeVibe");
  });

  test("starts from the top when nothing is persisted or the value is unknown", () => {
    expect(restoreNativeStep(null)).toBeNull();
    expect(restoreNativeStep("nativeName")).toBeNull();
    expect(restoreNativeStep("0")).toBeNull();
    expect(restoreNativeStep("garbage")).toBeNull();
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
    // `prevStep` walks to the previous *enabled* step, so a disabled step is
    // never a back target regardless of which capability gated it off.
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

describe("isPlatformFunnelAvailable", () => {
  test("platform mode is always available, with or without a session", () => {
    expect(
      isPlatformFunnelAvailable({ localMode: false, hasPlatformSession: false }),
    ).toBe(true);
    expect(
      isPlatformFunnelAvailable({ localMode: false, hasPlatformSession: true }),
    ).toBe(true);
  });

  test("local mode requires a live platform session", () => {
    expect(
      isPlatformFunnelAvailable({ localMode: true, hasPlatformSession: true }),
    ).toBe(true);
  });

  test("local mode with no session is unavailable — a cached id is not enough", () => {
    // A stale `cloud === "vellum"` lockfile entry can outlive the session, so
    // the funnel must not light up on cached state alone; only a live session
    // makes the platform-backed steps reachable.
    expect(
      isPlatformFunnelAvailable({ localMode: true, hasPlatformSession: false }),
    ).toBe(false);
  });
});
