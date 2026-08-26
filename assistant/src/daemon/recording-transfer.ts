import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { uploadFileBackedAttachment } from "../persistence/attachments-store.js";
import { getWorkspaceDir } from "../util/platform.js";

const TRANSFER_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

interface RecordingTransferSession {
  filePath: string;
  ownerClientId: string;
  write: Promise<void>;
  nextSequence: number;
  pendingSequences: Map<number, Promise<void>>;
  timeout: NodeJS.Timeout | null;
}

interface RecordingTransferDependencies {
  rootDir: string;
  registerAttachment: (
    filename: string,
    mimeType: string,
    filePath: string,
    sizeBytes: number,
  ) => { id: string };
}

export class RecordingTransferStore {
  private readonly sessions = new Map<string, RecordingTransferSession>();

  constructor(
    private readonly dependencies: RecordingTransferDependencies = {
      rootDir: path.join(
        getWorkspaceDir(),
        "data",
        "attachments",
        "recordings",
      ),
      registerAttachment: uploadFileBackedAttachment,
    },
  ) {}

  async begin(recordingId: string, clientId: string): Promise<void> {
    if (this.sessions.has(recordingId)) {
      throw new Error("Recording transfer already exists");
    }
    await mkdir(this.dependencies.rootDir, { recursive: true });
    const filePath = path.join(
      this.dependencies.rootDir,
      `screen-recording-${recordingId}.webm`,
    );
    await writeFile(filePath, new Uint8Array());
    const session: RecordingTransferSession = {
      filePath,
      ownerClientId: clientId,
      write: Promise.resolve(),
      nextSequence: 0,
      pendingSequences: new Map(),
      timeout: null,
    };
    this.sessions.set(recordingId, session);
    this.refreshTimeout(recordingId, session);
  }

  async append(
    recordingId: string,
    clientId: string,
    sequence: number,
    chunk: Uint8Array,
  ): Promise<void> {
    const session = this.getOwned(recordingId, clientId);
    if (sequence < session.nextSequence) {
      return;
    }
    const pending = session.pendingSequences.get(sequence);
    if (pending) {
      await pending;
      return;
    }
    if (sequence !== session.nextSequence) {
      throw new Error("Recording chunk arrived out of order");
    }
    const write = session.write.then(async () => {
      await appendFile(session.filePath, chunk);
      session.nextSequence += 1;
    });
    session.pendingSequences.set(sequence, write);
    session.write = write;
    this.refreshTimeout(recordingId, session);
    try {
      await write;
    } finally {
      if (session.pendingSequences.get(sequence) === write) {
        session.pendingSequences.delete(sequence);
      }
    }
  }

  async finish(recordingId: string, clientId: string): Promise<string> {
    const session = this.getOwned(recordingId, clientId);
    this.release(recordingId, session);
    try {
      await session.write;
      const sizeBytes = (await stat(session.filePath)).size;
      const attachment = this.dependencies.registerAttachment(
        path.basename(session.filePath),
        "video/webm",
        session.filePath,
        sizeBytes,
      );
      return attachment.id;
    } catch (error) {
      await rm(session.filePath, { force: true });
      throw error;
    }
  }

  async abort(recordingId: string, clientId: string): Promise<void> {
    const session = this.sessions.get(recordingId);
    if (!session) {
      return;
    }
    this.assertOwner(session, clientId);
    this.release(recordingId, session);
    await session.write.catch(() => undefined);
    await rm(session.filePath, { force: true });
  }

  private getOwned(
    recordingId: string,
    clientId: string,
  ): RecordingTransferSession {
    const session = this.sessions.get(recordingId);
    if (!session) {
      throw new Error("Recording transfer not found");
    }
    this.assertOwner(session, clientId);
    return session;
  }

  private assertOwner(
    session: RecordingTransferSession,
    clientId: string,
  ): void {
    if (session.ownerClientId !== clientId) {
      throw new Error("Recording transfer belongs to another client");
    }
  }

  private refreshTimeout(
    recordingId: string,
    session: RecordingTransferSession,
  ): void {
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
    session.timeout = setTimeout(() => {
      void this.abort(recordingId, session.ownerClientId).catch(
        () => undefined,
      );
    }, TRANSFER_IDLE_TIMEOUT_MS);
    session.timeout.unref?.();
  }

  private release(
    recordingId: string,
    session: RecordingTransferSession,
  ): void {
    this.sessions.delete(recordingId);
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
  }
}

export const recordingTransferStore = new RecordingTransferStore();
