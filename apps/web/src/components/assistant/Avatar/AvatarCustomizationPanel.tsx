
import { ChevronLeft, ChevronRight, Dices, Save, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchCharacterComponents, saveCharacterTraits } from "@/lib/avatar/api.js";
import type { CharacterComponents, CharacterTraits } from "@/lib/avatar/types.js";

import { AvatarRenderer } from "@/components/assistant/Avatar/AvatarRenderer.js";

export interface AvatarCustomizationPanelProps {
  assistantId: string;
  initialTraits?: CharacterTraits | null;
  onSave?: (traits: CharacterTraits) => void;
  onCancel?: () => void;
}

function cycleIndex(current: number, total: number, direction: "forward" | "backward"): number {
  if (direction === "forward") {
    return (current + 1) % total;
  }
  return (current - 1 + total) % total;
}

export function AvatarCustomizationPanel({
  assistantId,
  initialTraits,
  onSave,
  onCancel,
}: AvatarCustomizationPanelProps) {
  const [components, setComponents] = useState<CharacterComponents | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const fetchedRef = useRef<string | null>(null);

  const [bodyIndex, setBodyIndex] = useState(0);
  const [eyeIndex, setEyeIndex] = useState(0);
  const [colorIndex, setColorIndex] = useState(0);

  useEffect(() => {
    if (fetchedRef.current === assistantId) {
      return;
    }
    let cancelled = false;

    fetchCharacterComponents(assistantId).then((data) => {
      if (cancelled) {
        return;
      }
      fetchedRef.current = assistantId;
      setComponents(data);
      setIsLoading(false);

      if (data && initialTraits) {
        const bi = data.bodyShapes.findIndex((b) => b.id === initialTraits.bodyShape);
        const ei = data.eyeStyles.findIndex((e) => e.id === initialTraits.eyeStyle);
        const ci = data.colors.findIndex((c) => c.id === initialTraits.color);
        if (bi >= 0) {
          setBodyIndex(bi);
        }
        if (ei >= 0) {
          setEyeIndex(ei);
        }
        if (ci >= 0) {
          setColorIndex(ci);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [assistantId, initialTraits]);

  const handleRandomize = useCallback(() => {
    if (!components) {
      return;
    }
    setBodyIndex(Math.floor(Math.random() * components.bodyShapes.length));
    setEyeIndex(Math.floor(Math.random() * components.eyeStyles.length));
    setColorIndex(Math.floor(Math.random() * components.colors.length));
  }, [components]);

  const handleSave = useCallback(async () => {
    if (!components) {
      return;
    }
    const traits: CharacterTraits = {
      bodyShape: components.bodyShapes[bodyIndex]!.id,
      eyeStyle: components.eyeStyles[eyeIndex]!.id,
      color: components.colors[colorIndex]!.id,
    };

    setIsSaving(true);
    const success = await saveCharacterTraits(assistantId, traits);
    setIsSaving(false);

    if (success) {
      onSave?.(traits);
    }
  }, [components, bodyIndex, eyeIndex, colorIndex, assistantId, onSave]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600 dark:border-stone-600 dark:border-t-stone-300" />
      </div>
    );
  }

  if (!components) {
    return (
      <div className="py-8 text-center text-body-medium-lighter text-stone-500 dark:text-stone-400">
        Unable to load avatar components. Make sure your assistant is running.
      </div>
    );
  }

  const currentBody = components.bodyShapes[bodyIndex]!;
  const currentEye = components.eyeStyles[eyeIndex]!;
  const currentColor = components.colors[colorIndex]!;

  return (
    <div className="space-y-6">
      {/* Avatar preview */}
      <div className="flex justify-center">
        <div className="rounded-2xl bg-stone-100 p-6 dark:bg-moss-700">
          <AvatarRenderer
            components={components}
            bodyShapeId={currentBody.id}
            eyeStyleId={currentEye.id}
            colorId={currentColor.id}
            size={160}
          />
        </div>
      </div>

      {/* Cycle controls */}
      <div className="space-y-3">
        <CycleRow
          label="Body"
          value={currentBody.id}
          onPrev={() => setBodyIndex(cycleIndex(bodyIndex, components.bodyShapes.length, "backward"))}
          onNext={() => setBodyIndex(cycleIndex(bodyIndex, components.bodyShapes.length, "forward"))}
        />
        <CycleRow
          label="Eyes"
          value={currentEye.id}
          onPrev={() => setEyeIndex(cycleIndex(eyeIndex, components.eyeStyles.length, "backward"))}
          onNext={() => setEyeIndex(cycleIndex(eyeIndex, components.eyeStyles.length, "forward"))}
        />
        <CycleRow
          label="Color"
          value={currentColor.id}
          colorHex={currentColor.hex}
          onPrev={() => setColorIndex(cycleIndex(colorIndex, components.colors.length, "backward"))}
          onNext={() => setColorIndex(cycleIndex(colorIndex, components.colors.length, "forward"))}
        />
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleRandomize}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-body-medium-default text-stone-600 transition-colors hover:bg-stone-50 dark:border-moss-600 dark:bg-moss-700 dark:text-stone-300 dark:hover:bg-moss-600 cursor-pointer"
        >
          <Dices className="h-4 w-4" />
          Randomize
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-forest-600 bg-forest-100 px-3 py-2 text-body-medium-default text-forest-700 transition-colors hover:bg-forest-200 disabled:opacity-50 dark:border-forest-400 dark:bg-forest-950 dark:text-forest-300 dark:hover:bg-forest-900 cursor-pointer"
        >
          <Save className="h-4 w-4" />
          {isSaving ? "Saving..." : "Save Avatar"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center justify-center rounded-lg border border-stone-200 bg-white px-3 py-2 text-body-medium-default text-stone-600 transition-colors hover:bg-stone-50 dark:border-moss-600 dark:bg-moss-700 dark:text-stone-300 dark:hover:bg-moss-600 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CycleRow – a single row with left/right arrows and a label
// ---------------------------------------------------------------------------

interface CycleRowProps {
  label: string;
  value: string;
  colorHex?: string;
  onPrev: () => void;
  onNext: () => void;
}

function CycleRow({ label, value, colorHex, onPrev, onNext }: CycleRowProps) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-moss-600 dark:bg-moss-700">
      <span className="text-body-small-default uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-moss-600 cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-[80px] items-center justify-center gap-2">
          {colorHex && (
            <div
              className="h-4 w-4 rounded-full border border-stone-300 dark:border-stone-500"
              style={{ backgroundColor: colorHex }}
            />
          )}
          <span className="text-body-medium-default capitalize text-stone-700 dark:text-stone-200">
            {value}
          </span>
        </div>
        <button
          type="button"
          onClick={onNext}
          className="flex h-7 w-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-moss-600 cursor-pointer"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
