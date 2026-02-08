"use client";

import Link from "next/link";
import { ReactNode } from "react";

import { UserMenu } from "@/components/UserMenu";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
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
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
