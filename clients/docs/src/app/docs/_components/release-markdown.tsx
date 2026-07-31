"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ReleaseMarkdownProps {
  content: string;
}

export function ReleaseMarkdown({ content }: ReleaseMarkdownProps) {
  return (
    <div className="[&_h3]:mt-6 [&_h3]:mb-3 [&_h3]:text-xl [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_li]:mb-1.5 [&_li]:leading-relaxed [&_p]:mb-3 [&_code]:rounded [&_code]:bg-zinc-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm dark:[&_code]:bg-zinc-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
