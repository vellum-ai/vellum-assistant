"use client";

import { Menu } from "lucide-react";
import { useDocsNav } from "@/app/docs/_components/docs-nav-context";

export function DocsMobileMenuButton() {
  const { open } = useDocsNav();

  return (
    <button
      type="button"
      onClick={open}
      className="flex items-center justify-center border-none bg-transparent p-0 md:hidden"
      aria-label="Open navigation"
    >
      <Menu size={22} />
    </button>
  );
}
