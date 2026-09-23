import type { IpcRenderer, IpcRendererEvent } from "electron";
import type {
  CompanionAnnotationPhase,
  CompanionAnnotationStroke,
  CompanionAnnotationTool,
  CompanionCapturePick,
  CompanionCaptureSources,
  CompanionContext,
  ScreenCaptureFrame,
  WatchCaptureTarget,
  CompanionIntroAction,
  CompanionIntroAnnouncementAction,
  CompanionIntroCallControl,
  CompanionIntroReport,
  CompanionSurfaceState,
  DictationOfferAnswer,
  CompanionPopoverAnswer,
  CompanionPopoverView,
  CompanionPicker,
  VoiceActivityContent,
  VoiceActivityControl,
  VoiceActivityStart,
  VellumBridge,
} from "@vellumai/ipc-contract";
import { createDictationOfferBridge } from "./preload";

export const createCompanionBridge = (
  ipcRenderer: Pick<IpcRenderer, "invoke" | "send" | "on" | "off">,
): Required<Pick<VellumBridge, "companion" | "voiceActivity">> => ({
  voiceActivity: {
    start: (state: VoiceActivityStart): void => {
      ipcRenderer.send("vellum:voiceActivity:start", state);
    },
    update: (content: VoiceActivityContent): void => {
      ipcRenderer.send("vellum:voiceActivity:update", content);
    },
    end: (): void => {
      ipcRenderer.send("vellum:voiceActivity:end");
    },
    control: (control: VoiceActivityControl): void => {
      ipcRenderer.send("vellum:voiceActivity:control", control);
    },
    onControl: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: VoiceActivityControl,
      ) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:voiceActivity:controlEvent", handler);
      return () => {
        ipcRenderer.off("vellum:voiceActivity:controlEvent", handler);
      };
    },
  },
  companion: {
    onPointerPosition: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        point: { x: number; y: number },
      ) => callback(point);
      ipcRenderer.on("vellum:companion:pointer", handler);
      ipcRenderer.send("vellum:companion:watchPointer", true);
      return () => {
        ipcRenderer.off("vellum:companion:pointer", handler);
        ipcRenderer.send("vellum:companion:watchPointer", false);
      };
    },
    getState: (): Promise<CompanionSurfaceState | null> =>
      ipcRenderer.invoke(
        "vellum:companion:getState",
      ) as Promise<CompanionSurfaceState | null>,
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: CompanionSurfaceState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("vellum:companion:state", handler);
      return () => {
        ipcRenderer.off("vellum:companion:state", handler);
      };
    },
    getIntroAnnouncement: (): Promise<boolean> =>
      ipcRenderer.invoke(
        "vellum:companion:getIntroAnnouncement",
      ) as Promise<boolean>,
    answerIntroAnnouncement: (
      action: CompanionIntroAnnouncementAction,
    ): void => {
      ipcRenderer.send("vellum:companion:answerIntroAnnouncement", action);
    },
    onIntroAnnouncement: (callback) => {
      const handler = (_event: IpcRendererEvent, open: boolean) => {
        callback(open);
      };
      ipcRenderer.on("vellum:companion:introAnnouncement", handler);
      return () => {
        ipcRenderer.off("vellum:companion:introAnnouncement", handler);
      };
    },
    getIntroStage: (): Promise<boolean> =>
      ipcRenderer.invoke("vellum:companion:getIntroStage") as Promise<boolean>,
    onIntroStage: (callback) => {
      const handler = (_event: IpcRendererEvent, staged: boolean) => {
        callback(staged);
      };
      ipcRenderer.on("vellum:companion:introStage", handler);
      return () => {
        ipcRenderer.off("vellum:companion:introStage", handler);
      };
    },
    getIntroChord: (): Promise<CompanionIntroCallControl | null> =>
      ipcRenderer.invoke(
        "vellum:companion:getIntroChord",
      ) as Promise<CompanionIntroCallControl | null>,
    onIntroChord: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        control: CompanionIntroCallControl | null,
      ) => {
        callback(control);
      };
      ipcRenderer.on("vellum:companion:introChord", handler);
      return () => {
        ipcRenderer.off("vellum:companion:introChord", handler);
      };
    },
    onIntroReport: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        report: CompanionIntroReport,
      ) => {
        callback(report);
      };
      ipcRenderer.on("vellum:companion:introReport", handler);
      return () => {
        ipcRenderer.off("vellum:companion:introReport", handler);
      };
    },
    // Reports main held because there was no window listening for them, which
    // is how the run's own ending survives an app the user had closed. Taken,
    // not read: a second reader would report the same rows again.
    takeIntroReports: (): Promise<CompanionIntroReport[]> =>
      ipcRenderer.invoke("vellum:companion:takeIntroReports") as Promise<
        CompanionIntroReport[]
      >,
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send("vellum:companion:setInteractive", interactive);
    },
    moveBy: (dx: number, dy: number): void => {
      ipcRenderer.send("vellum:companion:moveBy", dx, dy);
    },
    release: (): void => {
      ipcRenderer.send("vellum:companion:release");
    },
    startVoice: (): void => {
      ipcRenderer.send("vellum:companion:startVoice");
    },
    toggleWatch: (pick?: CompanionCapturePick): void => {
      // Sent with no argument at all when there is no pick, so a main that
      // predates the picker still sees the empty tuple its schema expects.
      if (pick === undefined) {
        ipcRenderer.send("vellum:companion:toggleWatch");
        return;
      }
      ipcRenderer.send("vellum:companion:toggleWatch", pick);
    },
    listCaptureSources: (): Promise<CompanionCaptureSources> =>
      ipcRenderer.invoke(
        "vellum:companion:listCaptureSources",
      ) as Promise<CompanionCaptureSources>,
    setScreenShare: (pick?: CompanionCapturePick): void => {
      // Two shapes rather than an optional element, the way `toggleWatch` is
      // sent: a stop carries nothing at all.
      if (pick === undefined) {
        ipcRenderer.send("vellum:companion:setScreenShare");
        return;
      }
      ipcRenderer.send("vellum:companion:setScreenShare", pick);
    },
    setAnnotating: (annotating: boolean): void => {
      ipcRenderer.send("vellum:companion:setAnnotating", annotating);
    },
    toggleAnnotating: (): void => {
      ipcRenderer.send("vellum:companion:toggleAnnotating");
    },
    clearMarks: (): void => {
      ipcRenderer.send("vellum:companion:clearMarks");
    },
    setAnnotationTool: (tool: CompanionAnnotationTool): void => {
      ipcRenderer.send("vellum:companion:setAnnotationTool", tool);
    },
    annotateShare: (
      phase: CompanionAnnotationPhase,
      strokes: readonly CompanionAnnotationStroke[],
      ink: string,
    ): void => {
      ipcRenderer.send("vellum:companion:annotateShare", phase, strokes, ink);
    },
    setFrameScrolling: (scrolling: boolean): void => {
      ipcRenderer.send("vellum:companion:setFrameScrolling", scrolling);
    },
    frameDrawn: (): void => {
      ipcRenderer.send("vellum:companion:frameDrawn");
    },
    sharedFrame: (target: WatchCaptureTarget): void => {
      ipcRenderer.send("vellum:companion:sharedFrame", target);
    },
    captureScreen: (
      target: WatchCaptureTarget,
    ): Promise<ScreenCaptureFrame | null> =>
      ipcRenderer.invoke(
        "vellum:companion:captureScreen",
        target,
      ) as Promise<ScreenCaptureFrame | null>,
    captureSourceThumbnail: (
      target: WatchCaptureTarget,
    ): Promise<string | null> =>
      ipcRenderer.invoke(
        "vellum:companion:captureSourceThumbnail",
        target,
      ) as Promise<string | null>,
    answerWatchRetro: (open: boolean): void => {
      ipcRenderer.send("vellum:companion:answerWatchRetro", open);
    },
    ...createDictationOfferBridge(ipcRenderer),
    answerDictationOffer: (
      answer: DictationOfferAnswer,
      offerId: string,
    ): void => {
      ipcRenderer.send(
        "vellum:companion:answerDictationOffer",
        answer,
        offerId,
      );
    },
    answerPopover: (
      answer: CompanionPopoverAnswer,
      popoverId: string,
    ): void => {
      ipcRenderer.send("vellum:companion:answerPopover", answer, popoverId);
    },
    setPopoverSize: (
      popoverId: string,
      width: number,
      height: number,
    ): void => {
      ipcRenderer.send(
        "vellum:companion:setPopoverSize",
        popoverId,
        width,
        height,
      );
    },
    setPopoverView: (popoverId: string, view: CompanionPopoverView): void => {
      ipcRenderer.send("vellum:companion:setPopoverView", popoverId, view);
    },
    setAttachedPopoverHeight: (popoverId: string, height: number): void => {
      ipcRenderer.send(
        "vellum:companion:setAttachedPopoverHeight",
        popoverId,
        height,
      );
    },
    togglePicker: (picker: CompanionPicker): void => {
      ipcRenderer.send("vellum:companion:togglePicker", picker);
    },
    openLink: (url: string): void => {
      ipcRenderer.send("vellum:companion:openLink", url);
    },
    takesPrompts: (): Promise<boolean> =>
      ipcRenderer.invoke("vellum:companion:takesPrompts") as Promise<boolean>,
    activate: (): void => {
      ipcRenderer.send("vellum:companion:activate");
    },
    setContext: (context: CompanionContext): void => {
      ipcRenderer.send("vellum:companion:setContext", context);
    },
    advanceIntro: (action: CompanionIntroAction): void => {
      ipcRenderer.send("vellum:companion:advanceIntro", action);
    },
    showContextMenu: (): void => {
      ipcRenderer.send("vellum:companion:contextMenu");
    },
  },
});
