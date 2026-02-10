"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/app/core/Tabs";
import {
  DetailsTab,
  FileSystemTab,
  InteractionTab,
} from "@/components/app/pages/RightPanel";
import { UserMenu } from "@/components/shared/UserMenu";
import { Assistant } from "@/lib/db";

interface AppViewProps {
  assistantId: string;
}

export function AppView({ assistantId }: AppViewProps) {
  const [activeTab, setActiveTab] = useState("chat");
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAssistant = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}`);
      if (!response.ok) {
        return;
      }
      const data: Assistant = await response.json();
      setAssistant(data);
    } catch (error) {
      console.error("Failed to fetch assistant:", error);
    } finally {
      setIsLoading(false);
    }
  }, [assistantId]);

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  const assistantName = assistant?.name ?? "Assistant";
  const assistantCreatedAt = assistant?.createdAt ? String(assistant.createdAt) : "";

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-cloud-200 px-4 dark:border-sky-700">
        <TabsList variant="underline" className="border-b-0">
          <TabsTrigger value="chat" variant="underline">
            Chat
          </TabsTrigger>
          <TabsTrigger value="filesystem" variant="underline">
            File System
          </TabsTrigger>
          <TabsTrigger value="details" variant="underline">
            Details
          </TabsTrigger>
        </TabsList>
        <UserMenu />
      </div>

      <TabsContent value="chat" className="flex-1 overflow-hidden">
        <InteractionTab
          assistantId={assistantId}
          assistantName={assistantName}
          assistantCreatedAt={assistantCreatedAt}
        />
      </TabsContent>

      <TabsContent value="filesystem" className="flex-1 overflow-hidden">
        <FileSystemTab assistantId={assistantId} />
      </TabsContent>

      <TabsContent value="details" className="flex-1 overflow-hidden">
        <DetailsTab assistantId={assistantId} />
      </TabsContent>
    </Tabs>
  );
}
