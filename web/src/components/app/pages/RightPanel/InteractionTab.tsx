"use client";

import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FileImage,
  FileText,
  Loader2,
  Paperclip,
  Pause,
  Play,
  Send,
  Terminal,
  User,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button } from "@/components/app/core/Button";

type AssistantStatus = "healthy" | "unhealthy" | "stopped" | "unreachable" | "unknown" | "checking" | "getting_set_up" | "setting_up" | "provisioning_failed";

interface AssistantError {
  timestamp: string;
  message: string;
}

interface MessageAttachment {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  attachments: MessageAttachment[];
  toolCalls?: ToolCall[];
}

interface PendingAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "document";
  status: "uploading" | "uploaded" | "error";
  attachmentId?: string;
  error?: string;
}

interface InteractionTabProps {
  assistantId: string;
  assistantName: string;
  assistantCreatedAt: string;
}

const HEALTH_CHECK_INTERVAL = 10000;
const MESSAGE_POLL_INTERVAL = 5000;
const SETUP_GRACE_PERIOD_MS = 10 * 60 * 1000;

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  const kb = size / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

function inferKindFromMime(mimeType: string): "image" | "document" {
  return mimeType.toLowerCase().startsWith("image/") ? "image" : "document";
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const values = Object.values(input);
  if (values.length === 0) return "";
  const first = values[0];
  const str = typeof first === "string" ? first : JSON.stringify(first);
  return str.length > 80 ? `${str.slice(0, 77)}...` : str;
}

const TOOL_RESULT_MAX_LENGTH = 2000;

function ToolCallChip({ toolCall }: { toolCall: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolInput(toolCall.input);
  const hasResult = typeof toolCall.result === "string";

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => hasResult && setExpanded(!expanded)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
          toolCall.isError
            ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
            : "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
        } ${hasResult ? "cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800" : "cursor-default"}`}
      >
        <Terminal className="h-3 w-3 shrink-0" />
        <span className="font-medium">{toolCall.name}</span>
        {summary && (
          <>
            <span className="opacity-50">&mdash;</span>
            <span className="max-w-[300px] truncate opacity-75">{summary}</span>
          </>
        )}
        {hasResult && (
          expanded
            ? <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            : <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
        )}
      </button>
      {expanded && hasResult && (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {toolCall.result!.length > TOOL_RESULT_MAX_LENGTH
            ? `${toolCall.result!.slice(0, TOOL_RESULT_MAX_LENGTH)}...[truncated]`
            : toolCall.result}
        </pre>
      )}
    </div>
  );
}

export function InteractionTab({ assistantId, assistantName, assistantCreatedAt }: InteractionTabProps) {
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus>("checking");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [errors, setErrors] = useState<AssistantError[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadedPendingAttachmentIdsRef = useRef<string[]>([]);

  const fetchMessages = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}/messages`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const fetchedMessages: Message[] = (data.messages || []).map(
        (msg: {
          id: string;
          role: "user" | "assistant";
          content: string;
          timestamp: string;
          attachments?: MessageAttachment[];
          toolCalls?: ToolCall[];
        }) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
          attachments: msg.attachments || [],
          toolCalls: msg.toolCalls,
        })
      );

      if (data.errors && Array.isArray(data.errors)) {
        setErrors(data.errors);
      }

      setMessages(fetchedMessages);
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    }
  }, [assistantId]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, MESSAGE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}/health`);
      if (!response.ok) {
        setAssistantStatus("unknown");
        return;
      }
      const data = await response.json();
      if (data.status === "unknown" && data.message === "No compute instance configured") {
        setAssistantStatus("getting_set_up");
        setStatusMessage(null);
      } else if (data.status === "provisioning_failed") {
        setAssistantStatus("provisioning_failed");
        setStatusMessage(data.message || "Failed to create compute instance");
      } else if (data.status === "setting_up") {
        setAssistantStatus("setting_up");
        setStatusMessage(data.progress || null);
      } else if (data.status === "unreachable" && assistantCreatedAt) {
        const assistantAge = Date.now() - new Date(assistantCreatedAt).getTime();
        if (assistantAge < SETUP_GRACE_PERIOD_MS) {
          setAssistantStatus("getting_set_up");
          setStatusMessage(null);
        } else {
          setAssistantStatus("unreachable");
          setStatusMessage(data.message || null);
        }
      } else {
        setAssistantStatus(data.status as AssistantStatus);
        setStatusMessage(data.message || null);
      }
    } catch (error) {
      console.error("Health check failed:", error);
      setAssistantStatus("unknown");
    }
  }, [assistantId, assistantCreatedAt]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const isAlive = assistantStatus === "healthy";

  const lastMessage = messages[messages.length - 1];
  const isWaitingForResponse = lastMessage?.role === "user";

  const lastAssistantMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant"),
    [messages],
  );
  const lastAssistantMessageId = lastAssistantMessage?.id;

  const wasWaitingRef = useRef(false);
  const lastAlertedAssistantIdRef = useRef(lastAssistantMessageId);
  useEffect(() => {
    const hasNewAssistantMessage =
      lastAssistantMessageId !== undefined &&
      lastAssistantMessageId !== lastAlertedAssistantIdRef.current;
    if (wasWaitingRef.current && !isWaitingForResponse && hasNewAssistantMessage && !document.hasFocus()) {
      const audio = new Audio("/notification.mp3");
      audio.play().catch(() => {});
    }
    if (hasNewAssistantMessage) {
      lastAlertedAssistantIdRef.current = lastAssistantMessageId;
    }
    wasWaitingRef.current = isWaitingForResponse;
  }, [isWaitingForResponse, lastAssistantMessageId]);

  const [suggestion, setSuggestion] = useState<string | null>(null);
  const lastMessageId = lastMessage?.id;
  const lastMessageRole = lastMessage?.role;

  useEffect(() => {
    if (lastMessageRole !== "assistant" || isWaitingForResponse || !isAlive) {
      setSuggestion(null);
      return;
    }

    let cancelled = false;

    fetch(`/api/assistants/${assistantId}/suggestion${lastMessageId ? `?messageId=${lastMessageId}` : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ suggestion: string | null; messageId: string | null; stale?: boolean; source: string }>;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.stale) { setSuggestion(null); return; }
        if (data.suggestion && data.messageId === lastMessageId) {
          setSuggestion(data.suggestion);
        } else {
          setSuggestion(null);
        }
      })
      .catch(() => {
        setSuggestion(null);
      });

    return () => { cancelled = true; };
  }, [assistantId, lastMessageId, lastMessageRole, isWaitingForResponse, isAlive]);

  const ghostSuffix = useMemo(() => {
    if (!suggestion) return null;
    if (suggestion.startsWith(input)) return suggestion.slice(input.length) || null;
    if (input.length === 0) return suggestion;
    return null;
  }, [suggestion, input]);

  const uploadedAttachmentIds = useMemo(
    () => pendingAttachments
      .filter((attachment) => attachment.status === "uploaded" && attachment.attachmentId)
      .map((attachment) => attachment.attachmentId as string),
    [pendingAttachments],
  );
  const hasUploadingAttachments = pendingAttachments.some((attachment) => attachment.status === "uploading");

  useEffect(() => {
    uploadedPendingAttachmentIdsRef.current = uploadedAttachmentIds;
  }, [uploadedAttachmentIds]);

  const deleteUploadedAttachments = useCallback(async (attachmentIds: string[]) => {
    if (attachmentIds.length === 0) {
      return;
    }

    try {
      const response = await fetch(`/api/assistants/${assistantId}/attachments`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_ids: attachmentIds }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        console.warn("Failed to delete pending attachments:", data.error || "Unknown error");
      }
    } catch (error) {
      console.warn("Failed to delete pending attachments:", error);
    }
  }, [assistantId]);

  useEffect(() => {
    setPendingAttachments([]);
  }, [assistantId]);

  useEffect(() => {
    return () => {
      const pendingIds = uploadedPendingAttachmentIdsRef.current;
      if (pendingIds.length === 0) {
        return;
      }

      void fetch(`/api/assistants/${assistantId}/attachments`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_ids: pendingIds }),
        keepalive: true,
      });
    };
  }, [assistantId]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    const localEntries: PendingAttachment[] = files.map((file) => ({
      localId: crypto.randomUUID(),
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      kind: inferKindFromMime(file.type),
      status: "uploading",
    }));

    setPendingAttachments((prev) => [...prev, ...localEntries]);

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }

      const response = await fetch(`/api/assistants/${assistantId}/attachments`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to upload attachments");
      }

      const data = await response.json() as {
        attachments?: Array<{
          id: string;
          original_filename: string;
          mime_type: string;
          size_bytes: number;
          kind: string;
        }>;
      };

      const uploaded = data.attachments || [];
      if (uploaded.length !== localEntries.length) {
        throw new Error("Upload response did not match selected files");
      }

      const orphanedAttachmentIds: string[] = [];
      setPendingAttachments((prev) => {
        const localIndexById = new Map(localEntries.map((entry, index) => [entry.localId, index]));
        const activeLocalIds = new Set(prev.map((entry) => entry.localId));

        for (const [index, localEntry] of localEntries.entries()) {
          if (!activeLocalIds.has(localEntry.localId)) {
            const orphanedId = uploaded[index]?.id;
            if (typeof orphanedId === "string") {
              orphanedAttachmentIds.push(orphanedId);
            }
          }
        }

        return prev.map((entry) => {
          const index = localIndexById.get(entry.localId);
          if (index === undefined) {
            return entry;
          }
          const uploadedEntry = uploaded[index];
          return {
            ...entry,
            fileName: uploadedEntry.original_filename,
            mimeType: uploadedEntry.mime_type,
            sizeBytes: uploadedEntry.size_bytes,
            kind: uploadedEntry.kind === "image" ? "image" : "document",
            attachmentId: uploadedEntry.id,
            status: "uploaded",
            error: undefined,
          };
        });
      });

      if (orphanedAttachmentIds.length > 0) {
        void deleteUploadedAttachments(orphanedAttachmentIds);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Attachment upload failed";
      setPendingAttachments((prev) => {
        const localIds = new Set(localEntries.map((entry) => entry.localId));
        return prev.map((entry) => {
          if (!localIds.has(entry.localId)) {
            return entry;
          }
          return {
            ...entry,
            status: "error",
            error: errorMessage,
          };
        });
      });
    }
  }, [assistantId, deleteUploadedAttachments]);

  const handleOpenFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) {
      await uploadFiles(files);
    }
    event.target.value = "";
  }, [uploadFiles]);

  const handlePaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = Array.from(event.clipboardData.files || []);
    if (pastedFiles.length === 0) {
      return;
    }
    event.preventDefault();
    await uploadFiles(pastedFiles);
  }, [uploadFiles]);

  const handleDrop = useCallback(async (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    const droppedFiles = Array.from(event.dataTransfer.files || []);
    if (droppedFiles.length > 0) {
      await uploadFiles(droppedFiles);
    }
  }, [uploadFiles]);

  const removePendingAttachment = useCallback((localId: string) => {
    const selected = pendingAttachments.find((attachment) => attachment.localId === localId);
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.localId !== localId));

    if (selected?.status === "uploaded" && selected.attachmentId) {
      void deleteUploadedAttachments([selected.attachmentId]);
    }
  }, [deleteUploadedAttachments, pendingAttachments]);

  const handleStart = useCallback(async () => {
    setIsToggling(true);
    try {
      const response = await fetch(`/api/assistants/${assistantId}/start`, {
        method: "POST",
      });
      if (response.ok) {
        setAssistantStatus("checking");
        setTimeout(checkHealth, 5000);
      }
    } catch (error) {
      console.error("Failed to start assistant:", error);
    } finally {
      setIsToggling(false);
    }
  }, [assistantId, checkHealth]);

  const handleStop = useCallback(async () => {
    setIsToggling(true);
    try {
      const response = await fetch(`/api/assistants/${assistantId}/stop`, {
        method: "POST",
      });
      if (response.ok) {
        setAssistantStatus("checking");
        setTimeout(checkHealth, 5000);
      }
    } catch (error) {
      console.error("Failed to stop assistant:", error);
    } finally {
      setIsToggling(false);
    }
  }, [assistantId, checkHealth]);

  const handleToggleStatus = useCallback(() => {
    if (isAlive) {
      handleStop();
    } else {
      handleStart();
    }
  }, [isAlive, handleStart, handleStop]);

  const canSend = isAlive
    && !isLoading
    && !hasUploadingAttachments
    && (input.trim().length > 0 || uploadedAttachmentIds.length > 0);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSend) {
        return;
      }

      const trimmedInput = input.trim();
      const attachmentIds = [...uploadedAttachmentIds];
      const optimisticAttachments = pendingAttachments
        .filter((attachment) => attachment.status === "uploaded" && attachment.attachmentId)
        .map((attachment) => ({
          id: attachment.attachmentId as string,
          original_filename: attachment.fileName,
          mime_type: attachment.mimeType,
          size_bytes: attachment.sizeBytes,
          kind: attachment.kind,
        }));

      const userMessage: Message = {
        id: `optimistic-${crypto.randomUUID()}`,
        role: "user",
        content: trimmedInput,
        timestamp: new Date(),
        attachments: optimisticAttachments,
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setIsLoading(true);

      try {
        const response = await fetch(`/api/assistants/${assistantId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: trimmedInput, attachment_ids: attachmentIds }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to send message");
        }

        await fetchMessages();
        setPendingAttachments((prev) => prev.filter((attachment) => !attachmentIds.includes(attachment.attachmentId || "")));
      } catch (error) {
        console.error("Failed to send message:", error);
        setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
        setInput(trimmedInput);
      } finally {
        setIsLoading(false);
      }
    },
    [assistantId, canSend, fetchMessages, input, pendingAttachments, uploadedAttachmentIds],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab" && !e.shiftKey && ghostSuffix) {
        e.preventDefault();
        setInput(input + ghostSuffix);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e as unknown as FormEvent);
      }
    },
    [handleSubmit, ghostSuffix, input]
  );

  const getStatusDisplay = () => {
    switch (assistantStatus) {
      case "healthy":
        return { text: "Assistant is alive", color: "bg-green-500", pulse: true, tooltip: null };
      case "checking":
        return { text: "Checking status...", color: "bg-yellow-500", pulse: true, tooltip: null };
      case "getting_set_up":
        return { text: "Getting set up...", color: "bg-yellow-500", pulse: true, tooltip: null };
      case "setting_up":
        return { text: statusMessage ? `Setting up: ${statusMessage}` : "Setting up...", color: "bg-yellow-500", pulse: true, tooltip: null };
      case "provisioning_failed":
        return { text: "Setup failed", color: "bg-red-500", pulse: false, tooltip: statusMessage };
      case "stopped":
        return { text: "Assistant is stopped", color: "bg-zinc-400 dark:bg-zinc-600", pulse: false, tooltip: null };
      case "unreachable":
        return { text: "Assistant is unreachable", color: "bg-red-500", pulse: false, tooltip: statusMessage };
      case "unhealthy":
        return { text: "Assistant is unhealthy", color: "bg-red-500", pulse: false, tooltip: statusMessage };
      default:
        return { text: "Status unknown", color: "bg-zinc-400 dark:bg-zinc-600", pulse: false, tooltip: null };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3" title={statusDisplay.tooltip || undefined}>
            <div
              className={`flex h-3 w-3 rounded-full ${statusDisplay.color} ${
                statusDisplay.pulse ? "animate-pulse" : ""
              }`}
            />
            <span className="text-sm font-medium text-zinc-900 dark:text-white">
              {statusDisplay.text}
            </span>
          </div>
          <Button
            onClick={handleToggleStatus}
            disabled={isToggling || assistantStatus === "checking" || assistantStatus === "getting_set_up" || assistantStatus === "setting_up" || assistantStatus === "provisioning_failed" || assistantStatus === "unreachable"}
            variant="ghost"
            size="sm"
            icon={isToggling ? Loader2 : isAlive ? Pause : Play}
            className={
              isAlive
                ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900"
                : "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-950 dark:text-green-400 dark:hover:bg-green-900"
            }
          >
            {isToggling
              ? isAlive ? "Stopping..." : "Starting..."
              : isAlive ? "Pause" : "Start"}
          </Button>
        </div>
      </div>

      {errors.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900 dark:bg-amber-950">
          <button
            onClick={() => setShowErrors(!showErrors)}
            className="flex w-full items-center justify-between text-left"
          >
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              <span className="font-medium">
                {errors.length} recent error{errors.length !== 1 ? "s" : ""} detected
              </span>
            </div>
            <span className="text-xs text-amber-600 dark:text-amber-500">
              {showErrors ? "Hide" : "Show"}
            </span>
          </button>
          {showErrors && (
            <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
              {errors.map((error, idx) => (
                <div
                  key={idx}
                  className="rounded bg-amber-100 p-2 text-xs dark:bg-amber-900"
                >
                  <div className="font-mono text-amber-800 dark:text-amber-300">
                    {error.timestamp && (
                      <span className="opacity-70">[{error.timestamp}] </span>
                    )}
                    <span className="whitespace-pre-wrap break-all">
                      {error.message.length > 500
                        ? `${error.message.slice(0, 500)}...`
                        : error.message}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!isAlive ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
            {assistantStatus === "checking" || assistantStatus === "getting_set_up" ? (
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            ) : assistantStatus === "provisioning_failed" ? (
              <X className="h-8 w-8 text-red-400" />
            ) : (
              <Pause className="h-8 w-8 text-zinc-400" />
            )}
          </div>
          <h3 className="mt-4 text-lg font-medium text-zinc-900 dark:text-white">
            {assistantStatus === "checking" ? "Checking assistant status..." : assistantStatus === "getting_set_up" ? "Getting set up..." : assistantStatus === "setting_up" ? "Setting up..." : assistantStatus === "provisioning_failed" ? "Setup failed" : assistantStatus === "unreachable" ? "Assistant is unreachable" : "Assistant is not running"}
          </h3>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {assistantStatus === "checking"
              ? "Please wait while we check the assistant status"
              : assistantStatus === "getting_set_up"
                ? "Your assistant's compute instance is being created. This may take a minute."
                : assistantStatus === "setting_up"
                  ? statusMessage ?? "Your assistant is being configured."
                  : assistantStatus === "provisioning_failed"
                    ? statusMessage || "Failed to create the compute instance for this assistant."
                    : assistantStatus === "unreachable"
                      ? "The instance is running but the assistant server is not responding. Check the Details tab for more info."
                      : "Start the assistant to interact with it directly"}
          </p>
          {assistantStatus !== "checking" && assistantStatus !== "getting_set_up" && assistantStatus !== "setting_up" && assistantStatus !== "provisioning_failed" && assistantStatus !== "unreachable" && (
            <Button
              onClick={handleStart}
              disabled={isToggling}
              icon={isToggling ? Loader2 : Play}
              className="mt-4 bg-green-600 text-white hover:bg-green-700"
            >
              {isToggling ? "Starting..." : "Start Assistant"}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <Bot className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
                <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
                  Chat directly with {assistantName}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex gap-3 ${
                      message.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    {message.role === "assistant" && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-950">
                        <Bot className="h-4 w-4 text-green-600 dark:text-green-400" />
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] rounded-lg px-4 py-2 ${
                        message.role === "user"
                          ? "bg-indigo-600 text-white"
                          : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white"
                      }`}
                    >
                      {message.content ? (
                        <p className="whitespace-pre-wrap text-sm">
                          {message.content}
                        </p>
                      ) : null}

                      {message.attachments.length > 0 && (
                        <div className={`${message.content ? "mt-2" : ""} flex flex-wrap gap-2`}>
                          {message.attachments.map((attachment) => (
                            <div
                              key={attachment.id}
                              className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${
                                message.role === "user"
                                  ? "border-indigo-400 bg-indigo-500/40 text-indigo-50"
                                  : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                              }`}
                            >
                              {attachment.kind === "image" ? (
                                <FileImage className="h-3 w-3" />
                              ) : (
                                <FileText className="h-3 w-3" />
                              )}
                              <span className="max-w-[220px] truncate" title={attachment.original_filename}>
                                {attachment.original_filename}
                              </span>
                              <span className="opacity-75">{formatBytes(attachment.size_bytes)}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {message.toolCalls && message.toolCalls.length > 0 && (
                        <div className={message.content || message.attachments.length > 0 ? "mt-2" : ""}>
                          {message.toolCalls.map((tc, idx) => (
                            <ToolCallChip key={`${tc.name}-${idx}`} toolCall={tc} />
                          ))}
                        </div>
                      )}
                    </div>
                    {message.role === "user" && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700">
                        <User className="h-4 w-4 text-zinc-600 dark:text-zinc-300" />
                      </div>
                    )}
                  </div>
                ))}
                {(isLoading || isWaitingForResponse) && (
                  <div className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-950">
                      <Bot className="h-4 w-4 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="rounded-lg bg-zinc-100 px-4 py-2 dark:bg-zinc-800">
                      <div className="flex gap-1">
                        <div className="h-2 w-2 animate-bounce rounded-full bg-zinc-400" />
                        <div className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.1s]" />
                        <div className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0.2s]" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <form
            onSubmit={handleSubmit}
            className={`border-t p-4 transition-colors ${isDragOver ? "border-green-500 bg-green-50/70 dark:bg-green-950/20" : "border-zinc-200 dark:border-zinc-800"}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setIsDragOver(false);
              }
            }}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />

            {pendingAttachments.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {pendingAttachments.map((attachment) => (
                  <div
                    key={attachment.localId}
                    className={`inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${
                      attachment.status === "error"
                        ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
                        : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    }`}
                  >
                    {attachment.kind === "image" ? (
                      <FileImage className="h-3 w-3" />
                    ) : (
                      <FileText className="h-3 w-3" />
                    )}
                    <span className="max-w-[220px] truncate" title={attachment.fileName}>
                      {attachment.fileName}
                    </span>
                    <span className="opacity-75">{formatBytes(attachment.sizeBytes)}</span>
                    {attachment.status === "uploading" && <Loader2 className="h-3 w-3 animate-spin" />}
                    {attachment.status === "error" && attachment.error && (
                      <span className="max-w-[220px] truncate">{attachment.error}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removePendingAttachment(attachment.localId)}
                      className="rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                      aria-label={`Remove ${attachment.fileName}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleOpenFilePicker}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                disabled={isLoading}
                aria-label="Attach files"
                title="Attach files"
              >
                {hasUploadingAttachments ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </button>
              <div className="relative flex-1">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  rows={1}
                  className="relative z-10 w-full resize-none rounded-lg border border-zinc-200 bg-transparent px-4 py-2 text-sm text-zinc-900 caret-zinc-900 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 dark:border-zinc-700 dark:bg-transparent dark:text-white dark:caret-white"
                />
                {ghostSuffix && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent bg-white px-4 py-2 text-sm dark:bg-zinc-900"
                  >
                    <span className="invisible whitespace-pre">{input}</span>
                    <span className="text-zinc-400 dark:text-zinc-500">{ghostSuffix}</span>
                  </div>
                )}
                <span className="sr-only" aria-live="polite">
                  {ghostSuffix
                    ? `Suggestion available: ${suggestion}. Press Tab to accept.`
                    : ""}
                </span>
              </div>
              <Button
                type="submit"
                disabled={!canSend}
                size="icon"
                icon={Send}
                className="bg-green-600 text-white hover:bg-green-700"
              />
            </div>
            {hasUploadingAttachments && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Uploading attachments...
              </p>
            )}
          </form>
        </>
      )}
    </div>
  );
}
