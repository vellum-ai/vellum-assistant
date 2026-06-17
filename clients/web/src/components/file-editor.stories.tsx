import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import {
  ContentActionBar,
  EditFooter,
  FileTextarea,
  SourcePre,
} from "./file-editor";

const SAMPLE_CONTENT = `---
name: code-review
description: Reviews pull requests for style and correctness.
---

# Code Review Skill

This skill reviews code changes and provides feedback on:
- Style consistency
- Potential bugs
- Performance issues
`;

const meta: Meta = {
  title: "Components/FileEditor",
  parameters: { layout: "padded" },
};

export default meta;

export const ActionBarReadOnly: StoryObj = {
  name: "ContentActionBar — Read-only",
  render: () => (
    <div className="relative h-32 w-[500px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <ContentActionBar
        content={SAMPLE_CONTENT}
        fileName="SKILL.md"
        isEditing={false}
      />
      <pre className="p-4 text-body-small-default" style={{ color: "var(--content-default)" }}>
        {SAMPLE_CONTENT.slice(0, 80)}…
      </pre>
    </div>
  ),
};

export const ActionBarEditable: StoryObj = {
  name: "ContentActionBar — Editable",
  render: () => (
    <div className="relative h-32 w-[500px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <ContentActionBar
        content={SAMPLE_CONTENT}
        fileName="SKILL.md"
        showEdit
        isEditing={false}
        onToggleEdit={() => {}}
      />
      <pre className="p-4 text-body-small-default" style={{ color: "var(--content-default)" }}>
        {SAMPLE_CONTENT.slice(0, 80)}…
      </pre>
    </div>
  ),
};

export const ActionBarWithExtraActions: StoryObj = {
  name: "ContentActionBar — Extra actions",
  render: () => (
    <div className="relative h-32 w-[500px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <ContentActionBar
        content={SAMPLE_CONTENT}
        fileName="SKILL.md"
        showEdit
        isEditing={false}
        onToggleEdit={() => {}}
        extraActions={
          <Button
            variant="ghost"
            size="regular"
            iconOnly={<ExternalLink aria-hidden />}
            aria-label="Open in Workspace"
            className="hover:bg-[var(--surface-base)]"
          />
        }
      />
      <pre className="p-4 text-body-small-default" style={{ color: "var(--content-default)" }}>
        {SAMPLE_CONTENT.slice(0, 80)}…
      </pre>
    </div>
  ),
};

export const ActionBarHiddenWhileEditing: StoryObj = {
  name: "ContentActionBar — Hidden during edit",
  render: () => (
    <div className="relative h-32 w-[500px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <ContentActionBar
        content={SAMPLE_CONTENT}
        fileName="SKILL.md"
        showEdit
        isEditing={true}
        onToggleEdit={() => {}}
      />
      <p className="p-4 text-body-small-default" style={{ color: "var(--content-tertiary)" }}>
        Action bar is hidden during editing (renders null).
      </p>
    </div>
  ),
};

export const TextareaEditing: StoryObj = {
  name: "FileTextarea",
  render: function Render() {
    const [value, setValue] = useState(SAMPLE_CONTENT);
    return (
      <div className="h-64 w-[500px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
        <FileTextarea
          value={value}
          onChange={setValue}
          onSave={() => alert("Ctrl+S pressed")}
        />
      </div>
    );
  },
};

export const FooterClean: StoryObj = {
  name: "EditFooter — Clean (save disabled)",
  render: () => (
    <div className="w-[400px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <EditFooter
        isDirty={false}
        isSaving={false}
        onSave={() => {}}
        onDiscard={() => {}}
      />
    </div>
  ),
};

export const FooterDirty: StoryObj = {
  name: "EditFooter — Dirty (save enabled)",
  render: () => (
    <div className="w-[400px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <EditFooter
        isDirty={true}
        isSaving={false}
        onSave={() => {}}
        onDiscard={() => {}}
      />
    </div>
  ),
};

export const FooterSaving: StoryObj = {
  name: "EditFooter — Saving",
  render: () => (
    <div className="w-[400px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <EditFooter
        isDirty={true}
        isSaving={true}
        onSave={() => {}}
        onDiscard={() => {}}
      />
    </div>
  ),
};

export const FooterError: StoryObj = {
  name: "EditFooter — Error",
  render: () => (
    <div className="w-[400px] rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <EditFooter
        isDirty={true}
        isSaving={false}
        error="Save failed"
        onSave={() => {}}
        onDiscard={() => {}}
      />
    </div>
  ),
};

export const SourcePreReadOnly: StoryObj = {
  name: "SourcePre — Read-only",
  render: () => (
    <div className="h-64 w-[500px] overflow-hidden rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <SourcePre content={SAMPLE_CONTENT} readOnly />
    </div>
  ),
};

export const SourcePreEditable: StoryObj = {
  name: "SourcePre — Click to edit",
  render: () => (
    <div className="h-64 w-[500px] overflow-hidden rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
      <SourcePre
        content={SAMPLE_CONTENT}
        readOnly={false}
        onStartEdit={() => alert("Edit mode activated")}
      />
    </div>
  ),
};

export const FullEditorComposed: StoryObj = {
  name: "Full Editor — Composed",
  render: function Render() {
    const [isEditing, setIsEditing] = useState(false);
    const [editableContent, setEditableContent] = useState("");

    const isDirty = isEditing && editableContent !== SAMPLE_CONTENT;

    const startEditing = () => {
      setIsEditing(true);
      setEditableContent(SAMPLE_CONTENT);
    };

    const stopEditing = () => {
      setIsEditing(false);
      setEditableContent("");
    };

    return (
      <div className="flex h-80 w-[500px] flex-col rounded border border-[var(--border-element)] bg-[var(--surface-base)]">
        <div className="relative flex-1 overflow-hidden">
          <ContentActionBar
            content={isEditing ? editableContent : SAMPLE_CONTENT}
            fileName="SKILL.md"
            showEdit
            isEditing={isEditing}
            onToggleEdit={startEditing}
          />
          {isEditing ? (
            <FileTextarea
              value={editableContent}
              onChange={setEditableContent}
              onSave={() => alert("Save!")}
            />
          ) : (
            <SourcePre
              content={SAMPLE_CONTENT}
              readOnly={false}
              onStartEdit={startEditing}
            />
          )}
        </div>
        {isEditing && (
          <EditFooter
            isDirty={isDirty}
            isSaving={false}
            onSave={() => alert("Save!")}
            onDiscard={stopEditing}
          />
        )}
      </div>
    );
  },
};
