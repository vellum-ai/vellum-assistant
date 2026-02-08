"use client";

import { Bot, Home, LogOut, Menu, Settings, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { useAuth } from "@/lib/auth";

interface NavItem {
  href: string;
  icon: typeof Home;
  label: string;
}

const navItems: NavItem[] = [
  { href: "/", icon: Home, label: "Home" },
  { href: "/assistants", icon: Bot, label: "Assistants" },
  { href: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const { isLoggedIn, username, logout } = useAuth();

  const toggleSidebar = () => setIsOpen(!isOpen);
  const closeSidebar = () => setIsOpen(false);

  return (
    <>
      <button
        onClick={toggleSidebar}
        className="fixed left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-lg bg-white shadow-md md:hidden dark:bg-zinc-900"
        aria-label="Toggle menu"
      >
        {isOpen ? (
          <X className="h-5 w-5 text-zinc-600 dark:text-zinc-300" />
        ) : (
          <Menu className="h-5 w-5 text-zinc-600 dark:text-zinc-300" />
        )}
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={closeSidebar}
        />
      )}

      <aside
        className={`fixed z-40 flex h-screen w-64 flex-col border-r border-zinc-200 bg-white transition-transform duration-300 md:static md:translate-x-0 dark:border-zinc-800 dark:bg-zinc-950 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center border-b border-zinc-200 px-6 dark:border-zinc-800">
          <Link href="/" className="flex items-center gap-2" onClick={closeSidebar}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
              <span className="text-sm font-bold text-white">V</span>
            </div>
            <span className="text-lg font-semibold text-zinc-900 dark:text-white">
              Velly
            </span>
          </Link>
        </div>

        <nav className="flex-1 space-y-1 p-4">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href));
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={closeSidebar}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400"
                    : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
                }`}
              >
                <Icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {isLoggedIn && (
          <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
            <div className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              Logged in as <span className="font-medium">{username}</span>
            </div>
            <button
              onClick={() => {
                logout();
                closeSidebar();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
            >
              <LogOut className="h-5 w-5" />
              Logout
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
