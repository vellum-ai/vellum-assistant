"use client";

import { ReactNode } from "react";

import { Sidebar } from "@/components/Sidebar";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
      <Sidebar />
      <main className="flex-1 overflow-auto pt-16 md:pt-0">{children}</main>
    </div>
  );
}
