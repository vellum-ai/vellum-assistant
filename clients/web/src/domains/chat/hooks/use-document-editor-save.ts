import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  saveDocumentContent,
  trackDocumentSave,
  type DocumentSaveTarget,
} from "@/domains/chat/api/document-save";
import { captureError } from "@/lib/sentry/capture-error";

export interface DocumentEditorSnapshot {
  title: string;
  content: string;
}

export interface DocumentSendPreparation {
  flush: () => Promise<DocumentEditorSnapshot>;
  isCurrent: () => boolean;
  release: () => void;
}

interface UseDocumentEditorSaveOptions {
  target: DocumentSaveTarget;
  content: string;
  onRenamed?: (title: string) => void;
  /** Cache updates for a completed write, including after the editor unmounts. */
  onRenameSaved: (target: DocumentSaveTarget) => void;
  onRenameFailed: (error: unknown) => void;
}

/**
 * Serializes the mounted document's body and title writes. A preparation lease
 * holds editing until the shared chat submit path has taken the message.
 * The owner must remount when its assistant or surface changes.
 */
export function useDocumentEditorSave({
  target,
  content,
  onRenamed,
  onRenameSaved,
  onRenameFailed,
}: UseDocumentEditorSaveOptions) {
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [editingLocked, setEditingLocked] = useState(false);
  const [editorContent, setEditorContent] = useState(content);
  const [title, setTitle] = useState(target.title);
  const targetRef = useRef(target);
  const callbacksRef = useRef({ onRenamed, onRenameSaved, onRenameFailed });
  const latestRef = useRef<DocumentEditorSnapshot>({
    title: target.title,
    content,
  });
  const persistedRef = useRef<DocumentEditorSnapshot>({
    title: target.title,
    content,
  });
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const renameRevisionRef = useRef<number | null>(null);
  const activeSaveRef = useRef<Promise<DocumentEditorSnapshot> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const leasesRef = useRef(new Set<symbol>());
  const receivedRef = useRef({ title: target.title, content });

  useLayoutEffect(() => {
    targetRef.current = target;
    callbacksRef.current = { onRenamed, onRenameSaved, onRenameFailed };
    const previous = receivedRef.current;
    receivedRef.current = { title: target.title, content };
    if (
      revisionRef.current !== savedRevisionRef.current ||
      activeSaveRef.current !== null ||
      leasesRef.current.size > 0
    ) {
      return;
    }
    const contentChanged = content !== previous.content;
    const titleChanged = target.title !== previous.title;
    if (contentChanged || titleChanged) {
      latestRef.current = {
        title: titleChanged ? target.title : latestRef.current.title,
        content: contentChanged ? content : latestRef.current.content,
      };
      persistedRef.current = latestRef.current;
      if (contentChanged) {
        setEditorContent(content);
      }
      if (titleChanged) {
        setTitle(target.title);
      }
    }
  }, [target, content, onRenamed, onRenameSaved, onRenameFailed]);

  const clearTimers = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (fadeTimerRef.current !== null) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  const flushSave = useCallback((): Promise<DocumentEditorSnapshot> => {
    clearTimers();
    if (activeSaveRef.current !== null) {
      return activeSaveRef.current;
    }
    const drain = async () => {
      let wrote = false;
      while (savedRevisionRef.current !== revisionRef.current) {
        const revision = revisionRef.current;
        const snapshot = latestRef.current;
        const renameRevision = renameRevisionRef.current;
        const saveTarget = { ...targetRef.current, title: snapshot.title };
        try {
          await saveDocumentContent(saveTarget, snapshot.content);
          wrote = true;
        } catch (error) {
          if (
            renameRevision !== null &&
            renameRevisionRef.current === renameRevision
          ) {
            renameRevisionRef.current = null;
            latestRef.current = {
              ...latestRef.current,
              title: persistedRef.current.title,
            };
            if (mountedRef.current) {
              setTitle(persistedRef.current.title);
              callbacksRef.current.onRenamed?.(persistedRef.current.title);
              callbacksRef.current.onRenameFailed(error);
            }
          }
          if (revisionRef.current !== revision) {
            captureError(error, { context: "documentSaveSupersededRevision" });
            continue;
          }
          if (mountedRef.current) {
            setSaveStatus("idle");
          }
          throw error;
        }
        persistedRef.current = snapshot;
        savedRevisionRef.current = revision;
        if (renameRevision !== null) {
          if (renameRevisionRef.current === renameRevision) {
            renameRevisionRef.current = null;
          }
          callbacksRef.current.onRenameSaved(saveTarget);
        }
      }
      clearTimers();
      if (mountedRef.current && wrote) {
        setSaveStatus("saved");
        fadeTimerRef.current = setTimeout(() => setSaveStatus("idle"), 2000);
      }
      return { ...latestRef.current };
    };
    // Start on a microtask so concurrent flushes share this exact promise,
    // including a drain with no pending writes.
    const save = Promise.resolve()
      .then(drain)
      .finally(() => {
        if (activeSaveRef.current === save) {
          activeSaveRef.current = null;
        }
      });
    activeSaveRef.current = save;
    trackDocumentSave(targetRef.current, save);
    return save;
  }, [clearTimers]);

  const flushPendingSave = useCallback(async () => {
    if (!mountedRef.current) {
      throw new Error("Document editor is no longer active");
    }
    const snapshot = await flushSave();
    if (!mountedRef.current) {
      throw new Error("Document editor is no longer active");
    }
    return snapshot;
  }, [flushSave]);

  const beginSendPreparation = useCallback((): DocumentSendPreparation => {
    const lease = Symbol();
    if (mountedRef.current) {
      leasesRef.current.add(lease);
      setEditingLocked(true);
    }
    const isCurrent = () => mountedRef.current && leasesRef.current.has(lease);
    return {
      isCurrent,
      flush: async () => {
        if (!isCurrent()) {
          throw new Error("Document preparation is no longer active");
        }
        const snapshot = await flushPendingSave();
        if (!isCurrent()) {
          throw new Error("Document preparation is no longer active");
        }
        return snapshot;
      },
      release: () => {
        leasesRef.current.delete(lease);
        if (mountedRef.current && leasesRef.current.size === 0) {
          setEditingLocked(false);
        }
      },
    };
  }, [flushPendingSave]);

  const changeContent = useCallback(
    (markdown: string) => {
      if (!mountedRef.current || leasesRef.current.size > 0) {
        return false;
      }
      clearTimers();
      latestRef.current = { ...latestRef.current, content: markdown };
      revisionRef.current += 1;
      setSaveStatus("saving");
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave().catch((error: unknown) => {
          captureError(error, { context: "autosaveDocument" });
        });
      }, 1000);
      return true;
    },
    [clearTimers, flushSave],
  );

  const rename = useCallback(
    (nextTitle: string) => {
      const next = nextTitle.trim();
      if (
        !mountedRef.current ||
        leasesRef.current.size > 0 ||
        next === "" ||
        next === latestRef.current.title
      ) {
        return;
      }
      clearTimers();
      latestRef.current = { ...latestRef.current, title: next };
      revisionRef.current += 1;
      renameRevisionRef.current = revisionRef.current;
      setTitle(next);
      callbacksRef.current.onRenamed?.(next);
      setSaveStatus("saving");
      void flushSave().catch((error: unknown) => {
        captureError(error, { context: "renameDocument" });
      });
    },
    [clearTimers, flushSave],
  );

  useLayoutEffect(() => {
    mountedRef.current = true;
    const leases = leasesRef.current;
    return () => {
      mountedRef.current = false;
      leases.clear();
      clearTimers();
      if (revisionRef.current !== savedRevisionRef.current) {
        void flushSave().catch((error: unknown) => {
          captureError(error, { context: "closeDocumentSave" });
        });
      }
    };
  }, [clearTimers, flushSave]);

  return {
    saveStatus,
    editingLocked,
    editorContent,
    title,
    changeContent,
    rename,
    flushPendingSave,
    beginSendPreparation,
  };
}
