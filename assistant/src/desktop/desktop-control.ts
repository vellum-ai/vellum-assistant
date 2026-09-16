import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import {
  DesktopAutomationLease,
  desktopAutomationLease,
} from "./desktop-automation-lease.js";
import {
  desktopActionSchema,
  type DesktopInput,
  X11DesktopInput,
} from "./desktop-input.js";
import { getDesktopSessionManager } from "./desktop-session-manager.js";

export class DesktopControl {
  private observation?: {
    id: string;
    leaseId: string;
    sequence: number;
    width: number;
    height: number;
  };
  private readonly releaseInput = () => this.input.releaseInput();

  constructor(
    private readonly lease: DesktopAutomationLease = desktopAutomationLease,
    private readonly input: DesktopInput = new X11DesktopInput(),
    private readonly releaseBrowser: () => Promise<void> = () =>
      getDesktopSessionManager().browser.release(),
  ) {}

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = desktopActionSchema.safeParse(input);
    if (!parsed.success) {
      await this.lease.run(
        context,
        async () => {
          throw parsed.error;
        },
        { done: true },
      );
      throw parsed.error;
    }
    const action = parsed.data;
    return this.lease.run(
      context,
      async ({ signal, leaseId, sequence, assertAvailable }) => {
        await this.releaseBrowser();
        signal.throwIfAborted();
        assertAvailable();
        if (action.action !== "observe" && action.action !== "done") {
          const observation = this.observation;
          if (
            !observation ||
            observation.leaseId !== leaseId ||
            observation.sequence !== sequence - 1 ||
            observation.id !== action.observation_id
          ) {
            throw new Error(
              "Stale desktop observation. Observe again before acting.",
            );
          }
          if (
            "x" in action &&
            (action.x >= observation.width ||
              action.y >= observation.height ||
              (action.action === "drag" &&
                (action.to_x >= observation.width ||
                  action.to_y >= observation.height)))
          ) {
            throw new Error(
              "Coordinates must be inside the observed screenshot",
            );
          }
          this.observation = undefined;
          await this.input.perform(action, signal);
        }
        signal.throwIfAborted();
        assertAvailable();
        const observation = await this.input.observe(signal);
        signal.throwIfAborted();
        const id = crypto.randomUUID();
        this.observation = {
          id,
          leaseId,
          sequence,
          width: observation.width,
          height: observation.height,
        };
        return {
          isError: false,
          content: `Assistant desktop screenshot: ${observation.width}x${observation.height} pixels. observation_id: ${id}. Use coordinates in this image. Target: assistant-desktop. Capabilities: screenshot, click, type_text, key, scroll, drag, wait. Accessibility elements, window capture, app launch, AppleScript and sequences are unavailable.`,
          contentBlocks: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: observation.png.toString("base64"),
              },
            },
          ],
        };
      },
      {
        done: action.action === "done",
        requiresLease: action.action !== "observe",
        countAction: action.action !== "observe",
        cleanup: this.releaseInput,
      },
    );
  }
}

export const desktopControl = new DesktopControl();
