"use client";

import { FocusView } from "@/components/AssistantInitialization/FocusView";
import { useAuth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default function Home() {
  const { isLoggedIn, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  if (!isLoggedIn) {
    redirect("/login");
  }

  return <FocusView />;
}
