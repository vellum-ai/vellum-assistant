export type OpenRouterPickerModel = {
  id: string;
  displayName: string;
};

export type StoredOpenRouterCustomModel = {
  id: string;
  displayName?: string;
};

/**
 * Append user-added and already-bound OpenRouter ids after the curated
 * catalog, skipping duplicates so catalog order stays intact.
 */
export function collectOpenRouterPickerModels(
  catalogModels: readonly OpenRouterPickerModel[],
  stored: readonly StoredOpenRouterCustomModel[],
  boundModels: readonly StoredOpenRouterCustomModel[],
): OpenRouterPickerModel[] {
  const seen = new Set(catalogModels.map((model) => model.id));
  const extras: OpenRouterPickerModel[] = [];
  for (const model of [...stored, ...boundModels]) {
    const id = model.id.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    extras.push({
      id,
      displayName: model.displayName?.trim() || id,
    });
  }
  return [...catalogModels, ...extras];
}

export function harvestOpenRouterProfileModels(
  profiles:
    | Record<string, { provider?: string; model?: string } | undefined>
    | undefined,
): StoredOpenRouterCustomModel[] {
  const harvested: StoredOpenRouterCustomModel[] = [];
  for (const entry of Object.values(profiles ?? {})) {
    if (entry?.provider !== "openrouter") {
      continue;
    }
    const id = entry.model?.trim();
    if (!id) {
      continue;
    }
    harvested.push({ id });
  }
  return harvested;
}

export function appendOpenRouterCustomModel(
  existing: readonly StoredOpenRouterCustomModel[],
  next: StoredOpenRouterCustomModel,
): StoredOpenRouterCustomModel[] {
  if (existing.some((model) => model.id === next.id)) {
    return existing.map((model) =>
      model.id === next.id
        ? {
            id: next.id,
            displayName: next.displayName ?? model.displayName,
          }
        : model,
    );
  }
  return [...existing, next];
}
