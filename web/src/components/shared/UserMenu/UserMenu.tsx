"use client";

import { Home, LogOut, Settings, User } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/lib/auth";

const menuItemStyle = {
  color: "#52525b",
  textDecoration: "none",
};

const usernameStyle = {
  color: "#18181b",
  margin: 0,
};

export function UserMenu() {
  const { isLoggedIn, username, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
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
        style={menuItemStyle}
      >
        Sign in
      </Link>
    );
  }

  return (
    <div ref={menuRef} className="relative h-9 w-9 shrink-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium transition-colors"
        style={{ backgroundColor: "#e0e7ff", color: "#4f46e5" }}
        aria-label="User menu"
      >
        {username ? username.charAt(0).toUpperCase() : <User className="h-4 w-4" />}
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          style={{ color: "#52525b", fontFamily: "inherit", lineHeight: "normal" }}
        >
          <div className="border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
            <p className="text-sm font-medium" style={usernameStyle}>
              {username}
            </p>
          </div>

          <Link
            href="/"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            style={menuItemStyle}
          >
            <Home className="h-4 w-4" />
            Home
          </Link>

          <Link
            href="/settings"
            onClick={() => setIsOpen(false)}
            className="flex items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            style={menuItemStyle}
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>

          <div className="border-t border-zinc-200 dark:border-zinc-700">
            <button
              onClick={() => {
                logout();
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              style={menuItemStyle}
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
