"use client";

import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { ReactNode, useCallback, useEffect, useState } from "react";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  path: string;
  children?: FileEntry[];
  isLoading?: boolean;
}

interface FileSystemTabProps {
  assistantId: string;
}

export function FileSystemTab({ assistantId }: FileSystemTabProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("/opt/vellum-agent");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const fetchFilesForPath = useCallback(
    async (path: string): Promise<FileEntry[]> => {
      const response = await fetch(
        `/api/assistants/${assistantId}/ls?path=${encodeURIComponent(path)}`
      );
      if (!response.ok) {
        throw new Error("Failed to fetch files");
      }
      const data = await response.json();
      return (data.files || []).map((f: Omit<FileEntry, "path">) => ({
        ...f,
        path: `${path}/${f.name}`,
      }));
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
    (files: FileEntry[], targetPath: string, children: FileEntry[]): FileEntry[] => {
      return files.map((file) => {
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
    (files: FileEntry[], targetPath: string, loading: boolean): FileEntry[] => {
      return files.map((file) => {
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
            setFiles((prev) => updateFileChildren(prev, entry.path, children));
          } catch (err) {
            console.error("Failed to fetch directory contents:", err);
            setFiles((prev) => setFileLoading(prev, entry.path, false));
          }
        }
      }
    },
    [expandedDirs, fetchFilesForPath, setFileLoading, updateFileChildren]
  );

  const getFileIcon = (entry: FileEntry) => {
    if (entry.type === "directory") {
      return expandedDirs.has(entry.path) ? (
        <FolderOpen className="h-4 w-4 text-amber-500" />
      ) : (
        <Folder className="h-4 w-4 text-amber-500" />
      );
    }

    // Color code by file extension
    const ext = entry.name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "py":
        return <File className="h-4 w-4 text-blue-500" />;
      case "toml":
      case "json":
      case "yaml":
      case "yml":
        return <File className="h-4 w-4 text-purple-500" />;
      case "md":
        return <File className="h-4 w-4 text-zinc-500" />;
      case "env":
        return <File className="h-4 w-4 text-green-500" />;
      default:
        return <File className="h-4 w-4 text-zinc-400" />;
    }
  };

  const renderFileList = (entries: FileEntry[], depth = 0): ReactNode => {
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
            }
          }}
          className="flex w-full cursor-pointer items-center gap-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          style={{ paddingLeft: `${16 + depth * 16}px` }}
        >
          {entry.type === "directory" && (
            <>
              {entry.isLoading ? (
                <div className="h-3 w-3 animate-spin rounded-full border border-zinc-400 border-t-transparent" />
              ) : (
                <ChevronRight
                  className={`h-3 w-3 text-zinc-400 transition-transform ${
                    expandedDirs.has(entry.path) ? "rotate-90" : ""
                  }`}
                />
              )}
            </>
          )}
          {entry.type === "file" && <div className="w-3" />}
          {getFileIcon(entry)}
          <span
            className={`${
              entry.type === "directory"
                ? "text-zinc-900 dark:text-white"
                : "text-zinc-600 dark:text-zinc-400"
            }`}
          >
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2 overflow-hidden">
          <Folder className="h-4 w-4 shrink-0 text-zinc-400" />
          <span className="truncate font-mono text-sm text-zinc-600 dark:text-zinc-400">
            {currentPath}
          </span>
        </div>
        <button
          onClick={fetchFiles}
          disabled={isLoading}
          className="flex cursor-pointer items-center justify-center rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <RefreshCw
            className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && files.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <Folder className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
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
            {/* Parent directory */}
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
                <Folder className="h-4 w-4 text-amber-500" />
                <span className="text-zinc-600 dark:text-zinc-400">..</span>
              </button>
            )}

            {/* File list */}
            {renderFileList(files)}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="border-t border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {files.length} items
        </p>
      </div>
    </div>
  );
}
