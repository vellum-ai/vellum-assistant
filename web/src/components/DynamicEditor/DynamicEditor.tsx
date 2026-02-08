"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

import { UserMenu } from "@/components/UserMenu";

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
  const router = useRouter();
  const [compiled, setCompiled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const fetchedRef = useRef(false);

  const handleDelete = useCallback(async () => {
    if (!confirm("Are you sure you want to delete this assistant? This action cannot be undone.")) {
      return;
    }

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/assistants/${agentId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete assistant");
      }
      router.push("/assistant");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete assistant");
      setIsDeleting(false);
    }
  }, [agentId, router]);

  useEffect(() => {
    if (fetchedRef.current) {
      return;
    }
    fetchedRef.current = true;

    async function fetchEditor() {
      try {
        const response = await fetch(`/api/assistants/${agentId}/editor`);
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
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 bg-white px-4 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <span className="text-sm font-bold text-white">V</span>
            </div>
            <span className="text-lg font-semibold text-zinc-900 dark:text-white">
              Vellum
            </span>
          </Link>
          <UserMenu />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">
            Failed to load editor: {error}
          </p>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => {
                fetchedRef.current = false;
                setError(null);
                setIsLoading(true);
                setCompiled(null);
              }}
              className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
            >
              Retry
            </button>
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="flex cursor-pointer items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "Deleting..." : "Delete Assistant"}
            </button>
          </div>
        </div>
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
