import { create } from "zustand";

import {
  RADIO_TTS_SETTINGS_PATH,
  advanceRadio as advanceRadioApi,
  runtimeAudioUrl as runtimeAudioUrlApi,
} from "@/domains/radio/api.js";
import { RadioAudioController } from "@/domains/radio/audio-controller.js";
import type {
  RadioAdvanceReason,
  RadioAdvanceRequest,
  RadioAdvanceResponse,
  RadioDjBreak,
  RadioDisplayCue,
  RadioPlaybackPlan,
  RadioSetup,
  RadioStatus,
  RadioTrack,
  ResolvedRadioDjBreak,
  ResolvedRadioPlaybackPlan,
  ResolvedRadioTrack,
} from "@/domains/radio/types.js";
import { createSelectors } from "@/utils/create-selectors.js";

interface RadioController {
  playInitial: (track: ResolvedRadioTrack) => Promise<void> | void;
  pause: () => void;
  resume: () => Promise<void> | void;
  skip: () => void;
  dispose: () => void;
  applyTransition: (params: {
    outgoingTrack?: ResolvedRadioTrack | null;
    djBreak: ResolvedRadioDjBreak;
    nextTrack: ResolvedRadioTrack;
    playbackPlan: ResolvedRadioPlaybackPlan;
  }) => Promise<void> | void;
}

interface RadioStoreDependencies {
  advanceRadio: (
    assistantId: string,
    request: RadioAdvanceRequest,
  ) => Promise<RadioAdvanceResponse>;
  runtimeAudioUrl: (assistantId: string, audioPath: string) => string;
  createController: (callbacks: {
    onProgress: (event: { positionMs: number; remainingMs: number }) => void;
    onTrackEnding: () => void;
    onTrackEnded: () => void;
  }) => RadioController;
}

export interface RadioState {
  status: RadioStatus;
  displayCue: RadioDisplayCue | null;
  isExpanded: boolean;
  isHidden: boolean;
  currentTrack: ResolvedRadioTrack | null;
  nextTrack: ResolvedRadioTrack | null;
  djText: string | null;
  progressMs: number;
  remainingMs: number;
  setup: RadioSetup | null;
  errorMessage: string | null;
  segmentId: string | null;
  recentTrackIds: string[];
  assistantId: string | null;
}

export interface RadioActions {
  start: (assistantId: string) => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  skip: (assistantId: string) => Promise<void>;
  retry: (assistantId: string) => Promise<void>;
  toggleExpanded: () => void;
  setExpanded: (isExpanded: boolean) => void;
  hide: () => void;
  show: () => void;
  reset: () => void;
}

export type RadioStore = RadioState & RadioActions;

const INITIAL_STATE: RadioState = {
  status: "idle",
  displayCue: null,
  isExpanded: false,
  isHidden: false,
  currentTrack: null,
  nextTrack: null,
  djText: null,
  progressMs: 0,
  remainingMs: 0,
  setup: null,
  errorMessage: null,
  segmentId: null,
  recentTrackIds: [],
  assistantId: null,
};

const defaultDependencies: RadioStoreDependencies = {
  advanceRadio: advanceRadioApi,
  runtimeAudioUrl: runtimeAudioUrlApi,
  createController: (callbacks) => new RadioAudioController(callbacks),
};

let dependencies = defaultDependencies;
let controller: RadioController | null = null;
let advanceSequence = 0;
const inFlightAdvanceTokens = new Set<number>();

export function setRadioStoreDependencies(
  overrides: Partial<RadioStoreDependencies>,
): void {
  resetRuntimeController();
  invalidateAdvances();
  dependencies = { ...defaultDependencies, ...overrides };
}

export function resetRadioStoreDependencies(): void {
  resetRuntimeController();
  invalidateAdvances();
  dependencies = defaultDependencies;
}

function getBrowserLocale(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.language || undefined;
}

function errorMessageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Radio is unavailable.";
}

function appendRecentTrackId(ids: string[], trackId: string): string[] {
  return [...ids.filter((id) => id !== trackId), trackId].slice(-5);
}

function resolveTrack(assistantId: string, track: RadioTrack): ResolvedRadioTrack {
  return {
    ...track,
    audioUrl: dependencies.runtimeAudioUrl(assistantId, track.audioPath),
  };
}

function resolveDjBreak(
  assistantId: string,
  djBreak: RadioDjBreak,
): ResolvedRadioDjBreak {
  return {
    ...djBreak,
    audioUrl: dependencies.runtimeAudioUrl(assistantId, djBreak.audioPath),
  };
}

function resolvePlaybackPlan(
  assistantId: string,
  playbackPlan: RadioPlaybackPlan,
): ResolvedRadioPlaybackPlan {
  const { track: planTrack, djBreak: planDjBreak, ...planRest } = playbackPlan;
  const djBreak = planDjBreak
    ? resolveDjBreak(assistantId, planDjBreak)
    : undefined;
  return {
    ...planRest,
    track: resolveTrack(assistantId, planTrack),
    ...(djBreak ? { djBreak } : {}),
  };
}

function buildAdvanceRequest(
  state: RadioState,
  reason: RadioAdvanceReason,
  assistantId: string,
): RadioAdvanceRequest {
  const locale = getBrowserLocale();
  const canReuseStationState =
    !state.assistantId || state.assistantId === assistantId;
  return {
    reason,
    ...(canReuseStationState && state.segmentId
      ? { segmentId: state.segmentId }
      : {}),
    ...(canReuseStationState && state.currentTrack
      ? { currentTrackId: state.currentTrack.id }
      : {}),
    ...(canReuseStationState && state.recentTrackIds.length > 0
      ? { recentTrackIds: state.recentTrackIds }
      : {}),
    ...(locale ? { locale } : {}),
  };
}

function getRadioController(
  set: (partial: Partial<RadioStore>) => void,
  get: () => RadioStore,
): RadioController {
  if (controller) return controller;

  controller = dependencies.createController({
    onProgress: ({ positionMs, remainingMs }) => {
      set({ progressMs: positionMs, remainingMs });
    },
    onTrackEnding: () => {
      const assistantId = get().assistantId;
      if (!assistantId) return;
      void advanceWithReason("song_ended", assistantId, set, get);
    },
    onTrackEnded: () => {
      const assistantId = get().assistantId;
      if (!assistantId) return;
      void advanceWithReason("song_ended", assistantId, set, get);
    },
  });

  return controller;
}

function resetRuntimeController(): void {
  controller?.dispose();
  controller = null;
}

function invalidateAdvances(): void {
  advanceSequence += 1;
  inFlightAdvanceTokens.clear();
}

function startAdvance(reason: RadioAdvanceReason): number | null {
  if (reason === "song_ended" && inFlightAdvanceTokens.size > 0) {
    return null;
  }

  const token = ++advanceSequence;
  inFlightAdvanceTokens.add(token);
  return token;
}

function finishAdvance(token: number): void {
  inFlightAdvanceTokens.delete(token);
}

function isCurrentAdvance(token: number): boolean {
  return token === advanceSequence;
}

async function advanceWithReason(
  reason: RadioAdvanceReason,
  assistantId: string,
  set: (partial: Partial<RadioStore>) => void,
  get: () => RadioStore,
): Promise<void> {
  const token = startAdvance(reason);
  if (token === null) return;

  const previousState = get();
  const isAssistantSwitch =
    previousState.assistantId !== null &&
    previousState.assistantId !== assistantId;
  const requestState = isAssistantSwitch ? INITIAL_STATE : previousState;
  const outgoingTrack = isAssistantSwitch ? null : previousState.currentTrack;
  const loadingStatus =
    outgoingTrack && reason !== "start" ? "transitioning" : "loading";

  if (isAssistantSwitch) {
    resetRuntimeController();
  }

  set({
    status: loadingStatus,
    assistantId,
    ...(isAssistantSwitch
      ? {
          displayCue: null,
          currentTrack: null,
          nextTrack: null,
          djText: null,
          progressMs: 0,
          remainingMs: 0,
          segmentId: null,
          recentTrackIds: [],
        }
      : {}),
    setup: null,
    errorMessage: null,
    ...(reason === "start" ? { progressMs: 0, remainingMs: 0 } : {}),
  });

  try {
    const response = await dependencies.advanceRadio(
      assistantId,
      buildAdvanceRequest(requestState, reason, assistantId),
    );
    if (!isCurrentAdvance(token)) return;
    await applyAdvanceResponse({
      token,
      assistantId,
      reason,
      response,
      outgoingTrack,
      set,
      get,
    });
  } catch (error) {
    if (!isCurrentAdvance(token)) return;
    set({
      status: "error",
      displayCue: "error",
      errorMessage: errorMessageFrom(error),
    });
  } finally {
    finishAdvance(token);
  }
}

async function applyAdvanceResponse({
  token,
  assistantId,
  reason,
  response,
  outgoingTrack,
  set,
  get,
}: {
  token: number;
  assistantId: string;
  reason: RadioAdvanceReason;
  response: RadioAdvanceResponse;
  outgoingTrack: ResolvedRadioTrack | null;
  set: (partial: Partial<RadioStore>) => void;
  get: () => RadioStore;
}): Promise<void> {
  const track = resolveTrack(assistantId, response.track);
  const playbackPlan = resolvePlaybackPlan(assistantId, response.playbackPlan);
  const djBreak = response.djBreak
    ? resolveDjBreak(assistantId, response.djBreak)
    : playbackPlan.djBreak;
  const recentTrackIds = appendRecentTrackId(get().recentTrackIds, track.id);

  if (response.setup || response.displayCue === "setup_needed") {
    set({
      status: "setup_needed",
      displayCue: "setup_needed",
      segmentId: response.segmentId,
      currentTrack: outgoingTrack ? outgoingTrack : track,
      nextTrack: outgoingTrack ? track : null,
      setup:
        response.setup ?? {
          reason: "tts_unavailable",
          settingsPath: RADIO_TTS_SETTINGS_PATH,
          message: "Open Settings -> AI to configure text to speech.",
        },
      djText: djBreak?.text ?? null,
      errorMessage: null,
      recentTrackIds,
    });
    return;
  }

  if (reason === "start" || !outgoingTrack || !djBreak) {
    set({
      status: "playing",
      displayCue: response.displayCue,
      segmentId: response.segmentId,
      currentTrack: track,
      nextTrack: null,
      djText: djBreak?.text ?? null,
      setup: null,
      errorMessage: null,
      recentTrackIds,
    });
    await getRadioController(set, get).playInitial(track);
    return;
  }

  set({
    status: "transitioning",
    displayCue: response.displayCue,
    segmentId: response.segmentId,
    currentTrack: outgoingTrack,
    nextTrack: track,
    djText: djBreak.text,
    setup: null,
    errorMessage: null,
    recentTrackIds,
  });

  await getRadioController(set, get).applyTransition({
    outgoingTrack,
    djBreak,
    nextTrack: track,
    playbackPlan,
  });

  if (!isCurrentAdvance(token)) return;

  const statusAfterTransition = get().status;
  if (statusAfterTransition === "paused") {
    set({
      currentTrack: track,
      nextTrack: null,
    });
    return;
  }

  if (statusAfterTransition !== "transitioning") return;

  set({
    status: "playing",
    currentTrack: track,
    nextTrack: null,
  });
}

const useRadioStoreBase = create<RadioStore>()((set, get) => ({
  ...INITIAL_STATE,

  start: async (assistantId) => {
    await advanceWithReason("start", assistantId, set, get);
  },

  pause: () => {
    controller?.pause();
    if (get().currentTrack) {
      set({ status: "paused" });
    }
  },

  resume: async () => {
    if (!controller) return;
    await controller.resume();
    set({ status: "playing" });
  },

  skip: async (assistantId) => {
    await advanceWithReason("skip", assistantId, set, get);
  },

  retry: async (assistantId) => {
    await advanceWithReason("retry", assistantId, set, get);
  },

  toggleExpanded: () => {
    set({ isExpanded: !get().isExpanded });
  },

  setExpanded: (isExpanded) => {
    set({ isExpanded });
  },

  hide: () => {
    set({ isHidden: true });
  },

  show: () => {
    set({ isHidden: false });
  },

  reset: () => {
    resetRuntimeController();
    invalidateAdvances();
    set({ ...INITIAL_STATE });
  },
}));

export const useRadioStore = createSelectors(useRadioStoreBase);
