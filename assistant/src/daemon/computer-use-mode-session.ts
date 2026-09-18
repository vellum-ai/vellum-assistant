import type { ModeSession } from "../api/mode-session.js";
import type {
  ConversationModeSessionCoordinator,
  ModeSessionSourceHandle,
} from "./conversation-mode-session.js";
import { claimModeSessionTurn } from "./mode-session-tracking.js";

type ModeSessionCoordinator = Pick<
  ConversationModeSessionCoordinator,
  | "activateSource"
  | "beginDraining"
  | "claimTurn"
  | "getTurnOwner"
  | "recordActivity"
  | "retireSource"
>;

export interface ComputerUseSourceIdentity {
  sourceId: string;
  generation: number;
}

/** Maps validated host computer actions onto the shared session coordinator. */
export class ComputerUseModeSessionProducer {
  readonly #coordinator: ModeSessionCoordinator;
  readonly #isTrackingEnabled: () => boolean;
  #activeHandle?: ModeSessionSourceHandle;

  constructor(
    coordinator: ModeSessionCoordinator,
    isTrackingEnabled: () => boolean = () => true,
  ) {
    this.#coordinator = coordinator;
    this.#isTrackingEnabled = isTrackingEnabled;
  }

  recordAction(input: {
    turnId: string;
    source: ComputerUseSourceIdentity;
    at: number;
  }): ModeSession | undefined {
    const existingOwner = this.#coordinator.getTurnOwner(input.turnId);
    if (existingOwner) {
      this.#coordinator.recordActivity(input.turnId, input.at);
      return existingOwner;
    }

    if (!this.#isTrackingEnabled()) {
      return undefined;
    }

    const handle = this.#coordinator.activateSource({
      ...input.source,
      mode: "computer_use",
      sourceStartedAt: input.at,
    });
    if (!handle) {
      return undefined;
    }
    const owner = claimModeSessionTurn(
      this.#coordinator,
      input.turnId,
      handle,
      input.at,
    );
    if (owner?.id === handle.id) {
      this.#activeHandle = handle;
    }
    return owner;
  }

  endTask(input: {
    turnId?: string;
    source: ComputerUseSourceIdentity;
    disposition?: {
      status: "completed" | "interrupted";
      endReason: string;
    };
  }): boolean {
    const handle = this.#activeHandle;
    if (
      !handle ||
      handle.sourceId !== input.source.sourceId ||
      handle.generation !== input.source.generation
    ) {
      return false;
    }

    this.#activeHandle = undefined;
    const retired = this.#coordinator.retireSource(
      handle,
      input.disposition ?? {
        status: "completed",
        endReason: "computer_use_ended",
      },
    );
    if (
      input.turnId &&
      this.#coordinator.getTurnOwner(input.turnId)?.id === handle.id
    ) {
      this.#coordinator.beginDraining(input.turnId);
    }
    return retired;
  }
}
