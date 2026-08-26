import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { uploadFileBackedAttachment } from "../persistence/attachments-store.js";
import { getWorkspaceDir } from "../util/platform.js";

export const TRANSFER_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

interface RecordingTransferSession {
  filePath: string;
  ownerClientId: string;
  write: Promise<void>;
  nextSequence: number;
  pendingSequences: Map<number, Promise<void>>;
  finish: Promise<string> | null;
  timeout: NodeJS.Timeout | null;
}

interface RecordingTransferCompletion {
  attachmentId: string;
  ownerClientId: string;
  timeout: NodeJS.Timeout;
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
  private readonly completions = new Map<string, RecordingTransferCompletion>();
  private readonly beginOperations = new Map<string, Promise<void>>();

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
    const prior = this.beginOperations.get(recordingId) ?? Promise.resolve();
    const operation = prior.then(() => this.beginCore(recordingId, clientId));
    this.beginOperations.set(recordingId, operation);
    try {
      await operation;
    } finally {
      if (this.beginOperations.get(recordingId) === operation) {
        this.beginOperations.delete(recordingId);
      }
    }
  }

  private async beginCore(
    recordingId: string,
    clientId: string,
  ): Promise<void> {
    const existing = this.sessions.get(recordingId);
    if (existing?.ownerClientId === clientId) {
      return;
    }
    if (existing) {
      this.release(recordingId, existing);
      if (existing.finish) {
        await existing.finish.catch(() => undefined);
      } else {
        await existing.write.catch(() => undefined);
        await rm(existing.filePath, { force: true });
      }
    }
    const completion = this.completions.get(recordingId);
    if (completion?.ownerClientId === clientId) {
      throw new Error("Recording transfer already finished");
    }
    if (completion) {
      clearTimeout(completion.timeout);
      this.completions.delete(recordingId);
    }
    await mkdir(this.dependencies.rootDir, { recursive: true });
    const filePath = path.join(
      this.dependencies.rootDir,
      `screen-recording-${recordingId}-${randomUUID()}.webm`,
    );
    await writeFile(filePath, new Uint8Array());
    const session: RecordingTransferSession = {
      filePath,
      ownerClientId: clientId,
      write: Promise.resolve(),
      nextSequence: 0,
      pendingSequences: new Map(),
      finish: null,
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
    if (session.finish) {
      throw new Error("Recording transfer is finishing");
    }
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
    const completion = this.completions.get(recordingId);
    if (completion) {
      this.assertOwner(completion, clientId);
      return completion.attachmentId;
    }
    const session = this.getOwned(recordingId, clientId);
    if (!session.finish) {
      session.finish = (async () => {
        try {
          await session.write;
          const sizeBytes = (await stat(session.filePath)).size;
          const attachment = this.dependencies.registerAttachment(
            path.basename(session.filePath),
            "video/webm",
            session.filePath,
            sizeBytes,
          );
          this.release(recordingId, session);
          this.rememberCompletion(recordingId, clientId, attachment.id);
          return attachment.id;
        } catch (error) {
          this.release(recordingId, session);
          await rm(session.filePath, { force: true });
          throw error;
        }
      })();
    }
    return session.finish;
  }

  async abort(recordingId: string, clientId: string): Promise<void> {
    const completion = this.completions.get(recordingId);
    if (completion) {
      this.assertOwner(completion, clientId);
      return;
    }
    const session = this.sessions.get(recordingId);
    if (!session) {
      return;
    }
    this.assertOwner(session, clientId);
    this.release(recordingId, session);
    await session.write.catch(() => undefined);
    await rm(session.filePath, { force: true });
  }

  keepAlive(recordingId: string, clientId: string): boolean {
    const session = this.sessions.get(recordingId);
    if (!session || session.ownerClientId !== clientId || session.finish) {
      return false;
    }
    this.refreshTimeout(recordingId, session);
    return true;
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
    session: { ownerClientId: string },
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
    if (this.sessions.get(recordingId) === session) {
      this.sessions.delete(recordingId);
    }
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
  }

  private rememberCompletion(
    recordingId: string,
    ownerClientId: string,
    attachmentId: string,
  ): void {
    const timeout = setTimeout(() => {
      this.completions.delete(recordingId);
    }, TRANSFER_IDLE_TIMEOUT_MS);
    timeout.unref?.();
    this.completions.set(recordingId, {
      attachmentId,
      ownerClientId,
      timeout,
    });
  }
}

export const recordingTransferStore = new RecordingTransferStore();
