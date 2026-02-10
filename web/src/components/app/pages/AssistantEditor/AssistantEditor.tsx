"use client";

import { useState } from "react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/app/core/Tabs";
import { DynamicEditor } from "@/components/app/pages/DynamicEditor";

import { AppView } from "./_AppView";

interface AssistantEditorProps {
  assistantId: string;
  username: string | null;
}

export function AssistantEditor({ assistantId, username }: AssistantEditorProps) {
  const [activeTab, setActiveTab] = useState("app");

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
      <TabsList variant="pill" className="mx-4 mt-3 self-start">
        <TabsTrigger value="app" variant="pill">
          App
        </TabsTrigger>
        <TabsTrigger value="generated" variant="pill">
          Generated
        </TabsTrigger>
      </TabsList>

      <TabsContent value="app" className="flex-1 overflow-hidden">
        <AppView assistantId={assistantId} />
      </TabsContent>

      <TabsContent value="generated" className="flex-1 overflow-hidden">
        <DynamicEditor assistantId={assistantId} username={username} />
      </TabsContent>
    </Tabs>
  );
}
