"use client";

import { useParams } from "next/navigation";

import { DynamicEditor } from "@/components/DynamicEditor";
import { useAuth } from "@/lib/auth";

export default function AgentEditorPage() {
  const params = useParams();
  const { username } = useAuth();
  const agentId = params.id as string;

  return (
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <DynamicEditor agentId={agentId} username={username} />
    </div>
  );
}
