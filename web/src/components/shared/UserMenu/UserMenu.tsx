"use client";

import { Home, LogOut, Monitor, Moon, Settings, Sun, User } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/app/core/Button";
import { useAuth } from "@/lib/auth";

const emptySubscribe = () => () => {};

export function UserMenu() {
  const { isLoggedIn, username, logout } = useAuth();
  const { setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (!isLoggedIn) {
    return (
      <Link
        href="/login"
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-400 dark:hover:bg-indigo-900"
        aria-label="User menu"
      >
        {username ? username.charAt(0).toUpperCase() : <User className="h-4 w-4" />}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-56 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
            <p className="text-sm font-medium text-zinc-900 dark:text-white">
              {username}
            </p>
          </div>

          <Link
            href="/"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 px-4 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <Home className="h-4 w-4" />
            Home
          </Link>

          <Link
            href="/settings"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 px-4 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>

          {mounted && (
            <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 dark:border-zinc-700">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Theme</span>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Sun}
                  onClick={() => setTheme("light")}
                  aria-label="Light mode"
                  className="h-8 w-8 px-0"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Moon}
                  onClick={() => setTheme("dark")}
                  aria-label="Dark mode"
                  className="h-8 w-8 px-0"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Monitor}
                  onClick={() => setTheme("system")}
                  aria-label="System theme"
                  className="h-8 w-8 px-0"
                />
              </div>
            </div>
          )}

          <div className="border-t border-zinc-200 dark:border-zinc-700">
            <button
              onClick={() => {
                logout();
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
