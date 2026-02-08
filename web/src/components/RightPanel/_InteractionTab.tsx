"use client";

import { AlertTriangle, Bot, Loader2, Pause, Play, Send, User, X } from "lucide-react";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

type AgentStatus = "healthy" | "unhealthy" | "stopped" | "unreachable" | "unknown" | "checking" | "getting_set_up" | "setting_up" | "provisioning_failed";

interface AgentError {
  timestamp: string;
  message: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface InteractionTabProps {
  agentId: string;
  agentName: string;
  agentCreatedAt: string;
}

const HEALTH_CHECK_INTERVAL = 10000;
const MESSAGE_POLL_INTERVAL = 5000;
const SETUP_GRACE_PERIOD_MS = 10 * 60 * 1000;

export function InteractionTab({ agentId, agentName, agentCreatedAt }: InteractionTabProps) {
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [errors, setErrors] = useState<AgentError[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isToggling, setIsToggling] = useState(false);

  const fetchMessages = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${agentId}/messages`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      const fetchedMessages: Message[] = (data.messages || []).map(
        (msg: { id: string; role: "user" | "assistant"; content: string; timestamp: string }) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          timestamp: new Date(msg.timestamp),
        })
      );
      
      // Update errors if present
      if (data.errors && Array.isArray(data.errors)) {
        setErrors(data.errors);
      }
      
      setMessages(fetchedMessages);
    } catch (error) {
      console.error("Failed to fetch messages:", error);
    }
  }, [agentId]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, MESSAGE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${agentId}/health`);
      if (!response.ok) {
        setAgentStatus("unknown");
        return;
      }
      const data = await response.json();
      if (data.status === "unknown" && data.message === "No compute instance configured") {
        setAgentStatus("getting_set_up");
        setStatusMessage(null);
      } else if (data.status === "provisioning_failed") {
        setAgentStatus("provisioning_failed");
        setStatusMessage(data.message || "Failed to create compute instance");
      } else if (data.status === "setting_up") {
        setAgentStatus("setting_up");
        setStatusMessage(data.progress || null);
      } else if (data.status === "unreachable" && agentCreatedAt) {
        const agentAge = Date.now() - new Date(agentCreatedAt).getTime();
        if (agentAge < SETUP_GRACE_PERIOD_MS) {
          setAgentStatus("getting_set_up");
          setStatusMessage(null);
        } else {
          setAgentStatus("unreachable");
          setStatusMessage(data.message || null);
        }
      } else {
        setAgentStatus(data.status as AgentStatus);
        setStatusMessage(data.message || null);
      }
    } catch (error) {
      console.error("Health check failed:", error);
      setAgentStatus("unknown");
    }
  }, [agentId, agentCreatedAt]);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const isAlive = agentStatus === "healthy";
  
  // Show typing indicator when waiting for agent response
  const lastMessage = messages[messages.length - 1];
  const isWaitingForResponse = lastMessage?.role === "user";

  const handleStart = useCallback(async () => {
    setIsToggling(true);
    try {
      const response = await fetch(`/api/assistants/${agentId}/start`, {
        method: "POST",
      });
      if (response.ok) {
        setAgentStatus("checking");
        setTimeout(checkHealth, 5000);
      }
    } catch (error) {
      console.error("Failed to start agent:", error);
    } finally {
      setIsToggling(false);
    }
  }, [agentId, checkHealth]);

  const handleStop = useCallback(async () => {
    setIsToggling(true);
    try {
      const response = await fetch(`/api/assistants/${agentId}/stop`, {
        method: "POST",
      });
      if (response.ok) {
        setAgentStatus("checking");
        setTimeout(checkHealth, 5000);
      }
    } catch (error) {
      console.error("Failed to stop agent:", error);
    } finally {
      setIsToggling(false);
    }
  }, [agentId, checkHealth]);

  const handleToggleStatus = useCallback(() => {
    if (isAlive) {
      handleStop();
    } else {
      handleStart();
    }
  }, [isAlive, handleStart, handleStop]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isLoading || !isAlive) {
        return;
      }

      const userMessage: Message = {
        id: `optimistic-${crypto.randomUUID()}`,
        role: "user",
        content: input.trim(),
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setIsLoading(true);

      try {
        const response = await fetch(`/api/assistants/${agentId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: userMessage.content }),
        });

        if (!response.ok) {
          throw new Error("Failed to send message");
        }

        // Use preserveOptimistic to avoid flicker - merge server state with pending optimistic updates
        await fetchMessages();
      } catch (error) {
        console.error("Failed to send message:", error);
        // Remove the optimistic message on failure
        setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
      } finally {
        setIsLoading(false);
      }
    },
    [input, isLoading, isAlive, agentId, fetchMessages]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e as unknown as FormEvent);
      }
    },
    [handleSubmit]
  );

  const getStatusDisplay = () => {
    switch (agentStatus) {
      case "healthy":
        return { text: "Agent is alive", color: "bg-green-500", pulse: true, tooltip: null };
      case "checking":
        return { text: "Checking status...", color: "bg-yellow-500", pulse: true, tooltip: null };
      case "getting_set_up":
        return { text: "Getting set up...", color: "bg-yellow-500", pulse: true, tooltip: null };
      case "setting_up":
        return { text: statusMessage ? `Setting up: ${statusMessage}` : "Setting up...", color: "bg-yellow-500", pulse: true, tooltip: null };
      case "provisioning_failed":
        return { text: "Setup failed", color: "bg-red-500", pulse: false, tooltip: statusMessage };
      case "stopped":
        return { text: "Agent is stopped", color: "bg-zinc-400 dark:bg-zinc-600", pulse: false, tooltip: null };
      case "unreachable":
        return { text: "Agent is unreachable", color: "bg-red-500", pulse: false, tooltip: statusMessage };
      case "unhealthy":
        return { text: "Agent is unhealthy", color: "bg-red-500", pulse: false, tooltip: statusMessage };
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
          <button
            onClick={handleToggleStatus}
            disabled={isToggling || agentStatus === "checking" || agentStatus === "getting_set_up" || agentStatus === "setting_up" || agentStatus === "provisioning_failed" || agentStatus === "unreachable"}
            className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
              isAlive
                ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:hover:bg-amber-900"
                : "bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-950 dark:text-green-400 dark:hover:bg-green-900"
            }`}
          >
            {isToggling ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {isAlive ? "Stopping..." : "Starting..."}
              </>
            ) : isAlive ? (
              <>
                <Pause className="h-4 w-4" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Start
              </>
            )}
          </button>
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
            {agentStatus === "checking" || agentStatus === "getting_set_up" ? (
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            ) : agentStatus === "provisioning_failed" ? (
              <X className="h-8 w-8 text-red-400" />
            ) : (
              <Pause className="h-8 w-8 text-zinc-400" />
            )}
          </div>
          <h3 className="mt-4 text-lg font-medium text-zinc-900 dark:text-white">
            {agentStatus === "checking" ? "Checking agent status..." : agentStatus === "getting_set_up" ? "Getting set up..." : agentStatus === "setting_up" ? "Setting up..." : agentStatus === "provisioning_failed" ? "Setup failed" : agentStatus === "unreachable" ? "Agent is unreachable" : "Agent is not running"}
          </h3>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {agentStatus === "checking"
              ? "Please wait while we check the agent status"
              : agentStatus === "getting_set_up"
                ? "Your agent's compute instance is being created. This may take a minute."
                : agentStatus === "setting_up"
                  ? statusMessage ?? "Your agent is being configured."
                  : agentStatus === "provisioning_failed"
                    ? statusMessage || "Failed to create the compute instance for this agent."
                    : agentStatus === "unreachable"
                      ? "The instance is running but the agent server is not responding. Check the Details tab for more info."
                      : "Start the agent to interact with it directly"}
          </p>
          {agentStatus !== "checking" && agentStatus !== "getting_set_up" && agentStatus !== "setting_up" && agentStatus !== "provisioning_failed" && agentStatus !== "unreachable" && (
            <button
              onClick={handleStart}
              disabled={isToggling}
              className="mt-4 flex cursor-pointer items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
            >
              {isToggling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  Start Agent
                </>
              )}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <Bot className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
                <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
                  Chat directly with {agentName}
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
                      <p className="whitespace-pre-wrap text-sm">
                        {message.content}
                      </p>
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
            className="border-t border-zinc-200 p-4 dark:border-zinc-800"
          >
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${agentName}...`}
                rows={1}
                className="flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder-zinc-500"
              />
              <button
                type="submit"
                disabled={!input.trim() || isLoading}
                className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg bg-green-600 text-white transition-colors hover:bg-green-700 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
