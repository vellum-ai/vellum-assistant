"use client";

import {
  ComponentType,
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface DynamicEditorProps {
  agentId: string;
  username: string | null;
}

interface EditorComponentProps {
  agentId: string;
  username: string | null;
}

export function DynamicEditor({
  agentId,
  username,
}: DynamicEditorProps) {
  const [compiled, setCompiled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) {
      return;
    }
    fetchedRef.current = true;

    async function fetchEditor() {
      try {
        const response = await fetch(`/api/agents/${agentId}/editor`);
        if (!response.ok) {
          throw new Error("Failed to fetch editor page");
        }
        const data = await response.json();
        setCompiled(data.compiled);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load editor");
      } finally {
        setIsLoading(false);
      }
    }

    fetchEditor();
  }, [agentId]);

  const DynamicComponent = useMemo(() => {
    if (!compiled) {
      return null;
    }

    try {
      const wrappedCode = `
        ${compiled}
        return Editor;
      `;

      const factory = new Function(
        "React",
        "useState",
        "useEffect",
        "useCallback",
        "useMemo",
        "useRef",
        "Fragment",
        "createElement",
        wrappedCode
      );

      const Component = factory(
        { createElement, Fragment },
        useState,
        useEffect,
        useCallback,
        useMemo,
        useRef,
        Fragment,
        createElement
      ) as ComponentType<EditorComponentProps>;

      return Component;
    } catch (err) {
      console.error("Failed to mount dynamic editor:", err);
      setError(
        err instanceof Error ? err.message : "Failed to mount editor component"
      );
      return null;
    }
  }, [compiled]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to load editor: {error}
        </p>
        <button
          onClick={() => {
            fetchedRef.current = false;
            setError(null);
            setIsLoading(true);
            setCompiled(null);
          }}
          className="mt-4 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!DynamicComponent) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No editor component found
        </p>
      </div>
    );
  }

  return (
    <DynamicComponent
      agentId={agentId}
      username={username}
    />
  );
}
