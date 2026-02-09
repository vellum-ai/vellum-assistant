interface EditorProps {
  assistantId: string;
  username: string | null;
}

interface Assistant {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  configuration: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface AssistantDetails {
  instanceName: string | null;
  zone: string | null;
  ipAddress: string | null;
  assistantEmail: string | null;
}

type AssistantStatus =
  | "healthy"
  | "unhealthy"
  | "stopped"
  | "unreachable"
  | "unknown"
  | "checking"
  | "starting"
  | "getting_set_up"
  | "setting_up"
  | "provisioning_failed";

const SETUP_GRACE_PERIOD_MS = 10 * 60 * 1000;

type TabId =
  | "interaction"
  | "architecture"
  | "filesystem"
  | "logs"
  | "details";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  path: string;
  children?: FileEntry[];
  isLoading?: boolean;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "interaction", label: "Interaction" },
  { id: "architecture", label: "Architecture" },
  { id: "filesystem", label: "File System" },
  { id: "logs", label: "Logs" },
  { id: "details", label: "Details" },
];

function Editor({ assistantId, username }: EditorProps) {
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isKilling, setIsKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("interaction");
  const [name, setName] = useState("");

  const isOwner = !assistant?.created_by || assistant.created_by === username;

  const hasUnsavedChanges = useMemo(() => {
    if (!assistant) {
      return false;
    }
    return name !== assistant.name;
  }, [assistant, name]);

  const fetchAssistant = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}`);
      if (!response.ok) {
        throw new Error("Failed to fetch assistant");
      }
      const data = await response.json();
      setAssistant(data);
      setName(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsPageLoading(false);
    }
  }, [assistantId]);

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistants/${assistantId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        throw new Error("Failed to save assistant");
      }
      const updatedAssistant = await response.json();
      setAssistant(updatedAssistant);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save assistant");
    } finally {
      setIsSaving(false);
    }
  }, [assistantId, name]);

  const handleKill = useCallback(async () => {
    if (
      !window.confirm(
        "Are you sure you want to permanently delete this assistant and its compute instance? This action cannot be undone."
      )
    ) {
      return;
    }
    setIsKilling(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistants/${assistantId}/kill`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Failed to kill assistant");
      }
      window.location.href = "/assistants";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to kill assistant");
      setIsKilling(false);
    }
  }, [assistantId]);

  if (isPageLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (error && !assistant) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center">
        <p className="text-red-600 dark:text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <>
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex-1">
              <input
                type="text"
                value={name}
                onChange={(e: { target: { value: string } }) =>
                  setName(e.target.value)
                }
                disabled={!isOwner}
                className="w-full bg-transparent text-base font-semibold text-zinc-900 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:text-lg dark:text-white"
                placeholder="Assistant Name"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            {error && (
              <span className="hidden text-sm text-red-600 sm:inline dark:text-red-400">
                {error}
              </span>
            )}
            {isOwner && (
              <>
                <button
                  onClick={handleKill}
                  disabled={isKilling || isSaving}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                >
                  {isKilling ? "Killing..." : "Kill"}
                </button>
                <button
                  onClick={handleSave}
                  disabled={isSaving || isKilling || !hasUnsavedChanges}
                  className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </>
            )}
          </div>
          {error && (
            <span className="text-sm text-red-600 sm:hidden dark:text-red-400">
              {error}
            </span>
          )}
        </div>
        <div className="flex px-4 sm:px-6">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`cursor-pointer px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-b-2 border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                  : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="h-full w-full bg-white dark:bg-zinc-900">
          {activeTab === "interaction" && (
            <InteractionView
              assistantId={assistantId}
              assistantName={assistant?.name ?? "Assistant"}
              assistantCreatedAt={assistant?.created_at ?? ""}
            />
          )}
          {activeTab === "architecture" && (
            <ArchitectureView assistantName={assistant?.name ?? "Assistant"} />
          )}
          {activeTab === "filesystem" && (
            <FileSystemView assistantId={assistantId} />
          )}
          {activeTab === "logs" && <LogsView assistantId={assistantId} />}
          {activeTab === "details" && <DetailsView assistantId={assistantId} />}
        </div>
      </div>
    </>
  );
}

function InteractionView({
  assistantId,
  assistantName,
  assistantCreatedAt,
}: {
  assistantId: string;
  assistantName: string;
  assistantCreatedAt: string;
}) {
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus>("checking");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  const fetchMessages = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}/messages`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setMessages(
        (data.messages || []).map(
          (msg: {
            id: string;
            role: "user" | "assistant";
            content: string;
            timestamp: string;
          }) => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
          })
        )
      );
    } catch (fetchErr) {
      console.error("Failed to fetch messages:", fetchErr);
    }
  }, [assistantId]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
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
      if (
        data.status === "unknown" &&
        data.message === "No compute instance configured"
      ) {
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
    } catch (healthErr) {
      console.error("Health check failed:", healthErr);
      setAssistantStatus("unknown");
    }
  }, [assistantId, assistantCreatedAt]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 10000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const isAlive = assistantStatus === "healthy";

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
    } catch (startErr) {
      console.error("Failed to start assistant:", startErr);
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
    } catch (stopErr) {
      console.error("Failed to stop assistant:", stopErr);
    } finally {
      setIsToggling(false);
    }
  }, [assistantId, checkHealth]);

  const handleSubmit = useCallback(
    async (e: { preventDefault: () => void }) => {
      e.preventDefault();
      if (!input.trim() || isLoading || !isAlive) {
        return;
      }

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: input.trim(),
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setIsLoading(true);

      try {
        const response = await fetch(`/api/assistants/${assistantId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: userMessage.content }),
        });

        if (!response.ok) {
          throw new Error("Failed to send message");
        }

        // Don't call fetchMessages() here - it causes UI flicker by replacing
        // the optimistic message before the server has stored it.
        // The polling interval will sync messages automatically.
      } catch (sendErr) {
        console.error("Failed to send message:", sendErr);
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, isAlive, assistantId]
  );

  const getStatusDisplay = () => {
    switch (assistantStatus) {
      case "healthy":
        return { text: "Assistant is alive", color: "bg-green-500", pulse: true };
      case "checking":
        return {
          text: "Checking status...",
          color: "bg-yellow-500",
          pulse: true,
        };
      case "getting_set_up":
        return {
          text: "Getting set up...",
          color: "bg-yellow-500",
          pulse: true,
        };
      case "setting_up":
        return {
          text: statusMessage ? `Setting up: ${statusMessage}` : "Setting up...",
          color: "bg-yellow-500",
          pulse: true,
        };
      case "provisioning_failed":
        return { text: "Setup failed", color: "bg-red-500", pulse: false };
      case "starting":
        return {
          text: "Assistant is starting up...",
          color: "bg-yellow-500",
          pulse: true,
        };
      case "stopped":
        return {
          text: "Assistant is stopped",
          color: "bg-zinc-400 dark:bg-zinc-600",
          pulse: false,
        };
      case "unreachable":
        return {
          text: "Assistant is unreachable",
          color: "bg-red-500",
          pulse: false,
        };
      case "unhealthy":
        return {
          text: "Assistant is unhealthy",
          color: "bg-red-500",
          pulse: false,
        };
      default:
        return {
          text: "Status unknown",
          color: "bg-zinc-400 dark:bg-zinc-600",
          pulse: false,
        };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <div
            className="flex items-center gap-3"
            title={statusMessage ?? undefined}
          >
            <div
              className={`flex h-3 w-3 rounded-full ${statusDisplay.color} ${statusDisplay.pulse ? "animate-pulse" : ""}`}
            />
            <span className="text-sm font-medium text-zinc-900 dark:text-white">
              {statusDisplay.text}
            </span>
          </div>
          <button
            onClick={() => (isAlive ? handleStop() : handleStart())}
            disabled={
              isToggling ||
              assistantStatus === "checking" ||
              assistantStatus === "starting" ||
              assistantStatus === "getting_set_up" ||
              assistantStatus === "setting_up" ||
              assistantStatus === "provisioning_failed" ||
              assistantStatus === "unreachable"
            }
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
              isAlive
                ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900"
                : "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-950 dark:text-green-400 dark:hover:bg-green-900"
            }`}
          >
            {isToggling
              ? isAlive
                ? "Stopping..."
                : "Starting..."
              : isAlive
                ? "Pause"
                : "Start"}
          </button>
        </div>
      </div>

      {!isAlive ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <h3 className="mt-4 text-lg font-medium text-zinc-900 dark:text-white">
            {assistantStatus === "checking"
              ? "Checking assistant status..."
              : assistantStatus === "starting"
                ? "Assistant is starting up..."
                : assistantStatus === "getting_set_up"
                  ? "Getting set up..."
                  : assistantStatus === "setting_up"
                    ? "Setting up..."
                    : assistantStatus === "provisioning_failed"
                      ? "Setup failed"
                      : "Assistant is not running"}
          </h3>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {assistantStatus === "checking"
              ? "Please wait while we check the assistant status"
              : assistantStatus === "starting"
                ? "Your assistant's compute instance is booting up. This may take a minute."
                : assistantStatus === "getting_set_up"
                  ? "Your assistant's compute instance is being created."
                  : assistantStatus === "setting_up"
                    ? statusMessage ?? "Your assistant is being configured."
                    : assistantStatus === "provisioning_failed"
                      ? statusMessage ??
                        "Failed to create the compute instance for this assistant."
                      : "Start the assistant to interact with it directly"}
          </p>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
                  Chat directly with {assistantName}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    {message.role === "assistant" && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-950">
                        <span className="text-xs text-green-600 dark:text-green-400">
                          A
                        </span>
                      </div>
                    )}
                    <div
                      className={`max-w-[80%] rounded-lg px-4 py-2 ${
                        message.role === "user"
                          ? "bg-indigo-600 text-white"
                          : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white"
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-sm">
                        {message.content}
                      </p>
                    </div>
                    {message.role === "user" && (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-700">
                        <span className="text-xs text-zinc-600 dark:text-zinc-300">
                          U
                        </span>
                      </div>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="flex gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-950">
                      <span className="text-xs text-green-600 dark:text-green-400">
                        A
                      </span>
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
            className="border-t border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e: { target: { value: string } }) =>
                  setInput(e.target.value)
                }
                onKeyDown={(e: {
                  key: string;
                  shiftKey: boolean;
                  preventDefault: () => void;
                }) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder={`Message ${assistantName}...`}
                rows={1}
                className="flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder-zinc-500"
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg bg-green-600 text-white transition-colors hover:bg-green-700 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

function ArchitectureView({ assistantName }: { assistantName: string }) {
  return (
    <div className="flex h-full flex-col overflow-auto p-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 p-8 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex flex-col items-center">
            <div className="mb-4 flex items-center gap-4">
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 shadow-sm dark:border-amber-800 dark:bg-zinc-800">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Scheduled
                  </span>
                </div>
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
              </div>
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-2 rounded-lg border border-purple-200 bg-white px-3 py-2 shadow-sm dark:border-purple-800 dark:bg-zinc-800">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Slack
                  </span>
                </div>
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
              </div>
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 shadow-sm dark:border-blue-800 dark:bg-zinc-800">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Agent
                  </span>
                </div>
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
              </div>
            </div>

            <div className="mb-2 h-px w-48 bg-zinc-300 dark:bg-zinc-700" />
            <div className="mb-2 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />

            <div className="flex items-center gap-3 rounded-lg border-2 border-indigo-300 bg-white px-5 py-4 shadow-md dark:border-indigo-700 dark:bg-zinc-800">
              <div>
                <span className="font-semibold text-zinc-900 dark:text-white">
                  {assistantName}
                </span>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Main Assistant
                </p>
              </div>
            </div>

            <div className="mt-2 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
            <div className="mt-2 h-px w-64 bg-zinc-300 dark:bg-zinc-700" />

            <div className="mt-4 flex items-start gap-4">
              {["Search", "Code", "Chat", "API"].map((skill) => (
                <div key={skill} className="flex flex-col items-center">
                  <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                  <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 shadow-sm dark:border-emerald-800 dark:bg-zinc-800">
                    <span className="text-xs text-zinc-600 dark:text-zinc-300">
                      {skill}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileSystemView({ assistantId }: { assistantId: string }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("/opt/vellum-agent");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const fetchFilesForPath = useCallback(
    async (dirPath: string) => {
      const response = await fetch(
        `/api/assistants/${assistantId}/ls?path=${encodeURIComponent(dirPath)}`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch files");
      }
      const data = await response.json();
      return (data.files || []).map(
        (f: {
          name: string;
          type: "file" | "directory";
          size?: number;
          modified?: string;
        }) => ({
          ...f,
          path: `${dirPath}/${f.name}`,
        })
      );
    },
    [assistantId]
  );

  const fetchFileContent = useCallback(
    async (filePath: string) => {
      setIsLoadingContent(true);
      setContentError(null);
      setSelectedFile(filePath);
      try {
        const response = await fetch(
          `/api/assistants/${assistantId}/cat?path=${encodeURIComponent(filePath)}`
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to fetch file content");
        }
        const data = await response.json();
        setFileContent(data.content || "");
      } catch (err) {
        setContentError(err instanceof Error ? err.message : "Failed to load file");
        setFileContent(null);
      } finally {
        setIsLoadingContent(false);
      }
    },
    [assistantId]
  );

  const fetchFiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const fetchedFiles = await fetchFilesForPath(currentPath);
      setFiles(fetchedFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
      setFiles([]);
    } finally {
      setIsLoading(false);
    }
  }, [currentPath, fetchFilesForPath]);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const updateFileChildren = useCallback(
    (
      entries: FileEntry[],
      targetPath: string,
      children: FileEntry[]
    ): FileEntry[] => {
      return entries.map((file) => {
        if (file.path === targetPath) {
          return { ...file, children, isLoading: false };
        }
        if (file.children) {
          return {
            ...file,
            children: updateFileChildren(file.children, targetPath, children),
          };
        }
        return file;
      });
    },
    []
  );

  const setFileLoading = useCallback(
    (
      entries: FileEntry[],
      targetPath: string,
      loading: boolean
    ): FileEntry[] => {
      return entries.map((file) => {
        if (file.path === targetPath) {
          return { ...file, isLoading: loading };
        }
        if (file.children) {
          return {
            ...file,
            children: setFileLoading(file.children, targetPath, loading),
          };
        }
        return file;
      });
    },
    []
  );

  const toggleDirectory = useCallback(
    async (entry: FileEntry) => {
      const isExpanded = expandedDirs.has(entry.path);
      if (isExpanded) {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.delete(entry.path);
          return next;
        });
      } else {
        setExpandedDirs((prev) => {
          const next = new Set(prev);
          next.add(entry.path);
          return next;
        });
        if (!entry.children) {
          setFiles((prev) => setFileLoading(prev, entry.path, true));
          try {
            const children = await fetchFilesForPath(entry.path);
            setFiles((prev) =>
              updateFileChildren(prev, entry.path, children)
            );
          } catch (dirErr) {
            console.error("Failed to fetch directory contents:", dirErr);
            setFiles((prev) => setFileLoading(prev, entry.path, false));
          }
        }
      }
    },
    [expandedDirs, fetchFilesForPath, setFileLoading, updateFileChildren]
  );

  const getFileColor = (entry: FileEntry) => {
    if (entry.type === "directory") {
      return "text-amber-500 font-medium";
    }
    const ext = entry.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "py":
        return "text-blue-500";
      case "toml":
      case "json":
      case "yaml":
      case "yml":
        return "text-purple-500";
      case "md":
        return "text-zinc-500";
      case "env":
        return "text-green-500";
      default:
        return "text-zinc-600 dark:text-zinc-400";
    }
  };

  const renderFileList = (entries: FileEntry[], depth: number): unknown => {
    const sortedEntries = [...entries].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    return sortedEntries.map((entry) => (
      <div key={entry.path}>
        <button
          onClick={() => {
            if (entry.type === "directory") {
              toggleDirectory(entry);
            } else {
              fetchFileContent(entry.path);
            }
          }}
          className={`flex w-full cursor-pointer items-center gap-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 ${
            selectedFile === entry.path ? "bg-indigo-50 dark:bg-indigo-950" : ""
          }`}
          style={{ paddingLeft: `${16 + depth * 16}px` }}
        >
          {entry.type === "directory" && (
            <>
              {entry.isLoading ? (
                <div className="h-3 w-3 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
              ) : (
                <span
                  className={`inline-block w-3 text-xs text-zinc-400 transition-transform ${
                    expandedDirs.has(entry.path) ? "rotate-90" : ""
                  }`}
                >
                  &#9656;
                </span>
              )}
            </>
          )}
          {entry.type === "file" && <div className="w-3" />}
          <span className={`text-sm ${getFileColor(entry)}`}>
            {entry.name}
          </span>
        </button>
        {entry.type === "directory" &&
          expandedDirs.has(entry.path) &&
          entry.children && (
            <div>{renderFileList(entry.children, depth + 1)}</div>
          )}
      </div>
    ));
  };

  const getLanguageFromPath = (filePath: string) => {
    const ext = filePath.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "py": return "python";
      case "js": case "mjs": return "javascript";
      case "ts": case "tsx": return "typescript";
      case "json": return "json";
      case "yaml": case "yml": return "yaml";
      case "md": return "markdown";
      case "sh": case "bash": return "bash";
      default: return "plaintext";
    }
  };

  return (
    <div className="flex h-full">
      {/* Left panel - File tree */}
      <div className="flex w-1/3 min-w-[250px] flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="truncate font-mono text-sm text-zinc-600 dark:text-zinc-400">
              {currentPath}
            </span>
          </div>
          <button
            onClick={fetchFiles}
            disabled={isLoading}
            className="cursor-pointer rounded p-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            Refresh
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading && files.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <h3 className="mt-4 text-sm font-medium text-zinc-900 dark:text-white">
                Failed to load files
              </h3>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {error}
              </p>
              <button
                onClick={fetchFiles}
                className="mt-4 cursor-pointer rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-700"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="font-mono text-sm">
              {currentPath !== "/" && (
                <button
                  onClick={() => {
                    const parentPath = currentPath
                      .split("/")
                      .slice(0, -1)
                      .join("/");
                    setCurrentPath(parentPath || "/");
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <span className="text-amber-500">..</span>
                </button>
              )}
              {renderFileList(files, 0)}
            </div>
          )}
        </div>

        <div className="border-t border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {files.length} items
          </p>
        </div>
      </div>

      {/* Right panel - File content viewer */}
      <div className="flex flex-1 flex-col">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <span className="truncate font-mono text-sm text-zinc-900 dark:text-white">
                {selectedFile.split("/").pop()}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {getLanguageFromPath(selectedFile)}
              </span>
            </div>
            <div className="flex-1 overflow-auto bg-zinc-950 p-4">
              {isLoadingContent ? (
                <div className="flex items-center justify-center py-12">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
                </div>
              ) : contentError ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-sm text-red-400">{contentError}</p>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-green-400">
                  {fileContent}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Select a file to view its contents
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function LogsView({ assistantId }: { assistantId: string }) {
  const [logDates, setLogDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logContentRef = useRef<HTMLDivElement>(null);

  const fetchLogDates = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistants/${assistantId}/logs`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to fetch logs");
      }
      const data = await response.json();
      const logFiles: string[] = data.files || [];
      setLogDates(logFiles);
      if (logFiles.length > 0 && !selectedDate) {
        setSelectedDate(logFiles[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch logs");
    } finally {
      setIsLoading(false);
    }
  }, [assistantId, selectedDate]);

  const fetchLogContent = useCallback(
    async (date: string) => {
      setIsLoadingContent(true);
      try {
        const response = await fetch(
          `/api/assistants/${assistantId}/logs?date=${encodeURIComponent(date)}`
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to fetch log content");
        }
        const data = await response.json();
        setLogContent(data.content || "");
      } catch (err) {
        setLogContent(
          err instanceof Error ? err.message : "Failed to load log content"
        );
      } finally {
        setIsLoadingContent(false);
      }
    },
    [assistantId]
  );

  useEffect(() => {
    fetchLogDates();
  }, [fetchLogDates]);

  useEffect(() => {
    if (selectedDate) {
      fetchLogContent(selectedDate);
    }
  }, [selectedDate, fetchLogContent]);

  useEffect(() => {
    if (!isLoadingContent && logContent && logContentRef.current) {
      logContentRef.current.scrollTop = logContentRef.current.scrollHeight;
    }
  }, [isLoadingContent, logContent]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span className="text-sm font-medium text-zinc-900 dark:text-white">
          Assistant Logs
        </span>
        <button
          onClick={fetchLogDates}
          disabled={isLoading}
          className="cursor-pointer rounded p-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            {error}
          </p>
        </div>
      ) : logDates.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            No logs available yet
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            {logDates.map((date) => (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                className={`cursor-pointer whitespace-nowrap rounded px-3 py-1 text-xs font-medium transition-colors ${
                  selectedDate === date
                    ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {date}
              </button>
            ))}
          </div>

          <div ref={logContentRef} className="flex-1 overflow-auto bg-zinc-950 p-4">
            {isLoadingContent ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-green-400">
                {logContent}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailsView({ assistantId }: { assistantId: string }) {
  const [details, setDetails] = useState<AssistantDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDetails = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}`);
      if (!response.ok) {
        return;
      }
      const assistantData = await response.json();
      const computeConfig = assistantData.configuration?.compute as
        | { instanceName?: string; zone?: string }
        | undefined;
      const assistantmailConfig = assistantData.configuration?.agentmail as
        | { inbox_id?: string }
        | undefined;

      let ipAddress: string | null = null;
      if (computeConfig?.instanceName) {
        try {
          const healthResponse = await fetch(
            `/api/assistants/${assistantId}/health`
          );
          if (healthResponse.ok) {
            const healthData = await healthResponse.json();
            if (healthData.ip) {
              ipAddress = healthData.ip;
            }
          }
        } catch {
          ipAddress = null;
        }
      }

      setDetails({
        instanceName: computeConfig?.instanceName ?? null,
        zone: computeConfig?.zone ?? null,
        ipAddress,
        assistantEmail: assistantmailConfig?.inbox_id ?? null,
      });
    } catch (detailsErr) {
      console.error("Failed to fetch assistant details:", detailsErr);
    } finally {
      setIsLoading(false);
    }
  }, [assistantId]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (!details) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Failed to load assistant details
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-6 text-lg font-semibold text-zinc-900 dark:text-white">
        Assistant Details
      </h2>
      <div className="space-y-6">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 text-sm font-medium text-zinc-900 dark:text-white">
            GCP Instance
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">
                Instance Name
              </span>
              <span className="font-mono text-zinc-900 dark:text-white">
                {details.instanceName ?? "Not configured"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">Zone</span>
              <span className="font-mono text-zinc-900 dark:text-white">
                {details.zone ?? "Not configured"}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 text-sm font-medium text-zinc-900 dark:text-white">
            Network
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">
                IP Address
              </span>
              <span className="font-mono text-zinc-900 dark:text-white">
                {details.ipAddress ?? "Not configured"}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 text-sm font-medium text-zinc-900 dark:text-white">
            Assistant Email
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-500 dark:text-zinc-400">
                Email Address
              </span>
              <span className="font-mono text-zinc-900 dark:text-white">
                {details.assistantEmail ?? "Not configured"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
