import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Radio, RadioGroup } from "@vellumai/design-library/components/radio";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";
import {
  SearchableSelect,
  SEARCHABLE_SELECT_MENU_MIN_REACH,
  SEARCHABLE_SELECT_MENU_REACH,
  type SearchableSelectOption,
} from "@vellumai/design-library/components/searchable-select";
import { Tag } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

import { PROVIDER_DISPLAY_NAMES } from "@/assistant/llm-model-catalog";
import { ChatgptOAuthSection } from "@/domains/settings/ai/chatgpt-oauth-section";
import {
  CHATGPT_CONNECTION_PROVIDER,
  VELLUM_CONNECTION_PROVIDER,
} from "@/domains/settings/ai/constants";
import {
  collapseSectionRows,
  customModelProviderCandidates,
  defaultProviderCandidate,
  resolveModelFirstGroups,
  type ModelFirstInput,
  type ModelFirstOption,
  type ProviderCandidate,
} from "@/domains/settings/ai/model-first-candidates";
import { entryPickerValue } from "@/domains/settings/ai/provider-availability";
import { PickerMeta } from "@/domains/settings/ai/provider-picker-availability";
import { ProviderCreateForm } from "@/domains/settings/ai/provider-create-form";
import type { ProfileEditor } from "@/domains/settings/ai/use-profile-editor";
import { useActiveAssistantIsSelfHosted } from "@/hooks/use-platform-gate";
import { useTranslation, type TFunction } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

/**
 * Sentinel for the Model list's sticky escape hatch. Namespaced so it can
 * never collide with a model's display name.
 */
const CUSTOM_MODEL_OPTION_VALUE = "__custom-model-id__";

/**
 * Prefix for the row that unfolds the rest of one section. Namespaced the
 * same way, and carrying the section it acts on, so picking it is told apart
 * from picking a model.
 */
const SEE_MORE_PREFIX = "__see-more__:";

/**
 * Where one model row stands in its section's disclosure: one of the rows the
 * section offers, one still folded away, or one the unfold row has revealed.
 */
type ModelRowState = "current" | "folded" | "disclosed";

/**
 * What the user has answered to the flow's first question. A catalog pick is
 * held by display name because that is the identity a model keeps across the
 * providers that host it; the per-provider id follows from the route chosen
 * next.
 */
type ModelDraft =
  | { readonly kind: "none" }
  | { readonly kind: "catalog"; readonly displayName: string }
  | { readonly kind: "custom"; readonly modelId: string };

const NO_MODEL: ModelDraft = { kind: "none" };

/** The Model label: one line of `text-body-small-default`, whose leading is 1. */
const MODEL_LABEL_HEIGHT = 12;

/** The `space-y-1` between the label and the field under it. */
const MODEL_LABEL_GAP = 4;

/** The field itself, which is an `h-9` input. */
const MODEL_FIELD_HEIGHT = 36;

/** The Model field with its label, from the top of one to the foot of the other. */
const MODEL_FIELD_BLOCK =
  MODEL_LABEL_HEIGHT + MODEL_LABEL_GAP + MODEL_FIELD_HEIGHT;

/**
 * Room the Model field and its open list need, measured from the top of the
 * label to the bottom of a list at its full height.
 *
 * The dialog is as tall as what it holds, and the list is portaled, so it is
 * not what it holds. Bounding the list to the dialog body is what keeps it
 * off the footer; reserving this is what keeps the body from being too short
 * to hold the list the bound then caps.
 */
const MODEL_LIST_ROOM = MODEL_FIELD_BLOCK + SEARCHABLE_SELECT_MENU_REACH;

/** The same room for a list at its floor, which is all a picked model spares. */
const MODEL_LIST_MIN_ROOM =
  MODEL_FIELD_BLOCK + SEARCHABLE_SELECT_MENU_MIN_REACH;

export interface ProfileCreateModelFirstProps {
  editor: ProfileEditor;
  /** Assistant whose connections the inline connect form writes to. */
  assistantId: string;
  /**
   * Box the open model list is kept inside, and which the field stack then
   * keeps tall enough to hold it. Pass the scrolling body of a host whose own
   * actions sit under the field: a dialog, which is only as tall as its
   * content and whose footer is the next thing below the field. The settings
   * sidepanel is already full height and passes nothing.
   */
  menuBoundary?: Element | null;
}

/**
 * The model-first create flow: pick the model, then the route that serves it.
 *
 * The provider question is asked only when there is something to decide. One
 * candidate that is already connected answers itself and is shown as a fact;
 * several candidates become radio cards with the connected ones first; a
 * candidate with no connection yet expands into the connect form it needs, and
 * nothing is bound to the profile until that form produces a connection.
 *
 * It drives the same `useProfileEditor` state the provider-first flow drives,
 * so a profile saved through either is byte-identical on the wire.
 */
export function ProfileCreateModelFirst({
  editor,
  assistantId,
  menuBoundary,
}: ProfileCreateModelFirstProps) {
  const { t } = useTranslation("settings");
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  const developerMode = useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const defaultEntryMetaLabel = t("aiProviderPicker.defaultEntryMeta");

  const resolverInput = useMemo<ModelFirstInput>(
    () => ({
      connections: editor.effectiveConnections,
      developerMode,
      activeAssistantIsSelfHosted,
      labelFor: (provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider,
      defaultEntryMetaLabel,
    }),
    [
      editor.effectiveConnections,
      developerMode,
      activeAssistantIsSelfHosted,
      defaultEntryMetaLabel,
    ],
  );

  const groups = useMemo(
    () => resolveModelFirstGroups(resolverInput),
    [resolverInput],
  );
  const options = useMemo(
    () => groups.flatMap((group) => group.options),
    [groups],
  );

  // Sections the user has unfolded. The control that unfolds one sits on its
  // heading rather than under its rows, so folding it back is a deliberate
  // second press on the same control and never moves what is under the hand.
  const [unfoldedGroups, setUnfoldedGroups] = useState<readonly string[]>([]);

  // "Save As New" opens create mode on a profile that already has a provider
  // and a model, so the flow starts on whichever answer that model is: a
  // catalog entry the list offers, or an id only free text can express.
  const [draft, setDraft] = useState<ModelDraft>(() => {
    if (editor.model === "") {
      return NO_MODEL;
    }
    const seeded = options.find((option) =>
      option.candidates.some(
        (candidate) =>
          candidate.provider === editor.provider &&
          candidate.modelId === editor.model,
      ),
    );
    return seeded
      ? { kind: "catalog", displayName: seeded.displayName }
      : { kind: "custom", modelId: editor.model };
  });
  const [selectedValue, setSelectedValue] = useState(() => {
    if (editor.provider === "") {
      return "";
    }
    return editor.providerConnection === ""
      ? editor.provider
      : entryPickerValue(editor.provider, editor.providerConnection);
  });

  // The candidate whose connect form is expanded. Separate from the selection
  // so cancelling the form collapses it without deselecting the route, which
  // would leave a lone unconnected candidate with nothing left to click.
  const [setupOpenFor, setSetupOpenFor] = useState<string | null>(null);

  const candidates = useMemo<readonly ProviderCandidate[]>(() => {
    if (draft.kind === "catalog") {
      return (
        options.find((option) => option.displayName === draft.displayName)
          ?.candidates ?? []
      );
    }
    if (draft.kind === "custom") {
      return customModelProviderCandidates(resolverInput, draft.modelId);
    }
    return [];
  }, [draft, options, resolverInput]);

  const selectedCandidate =
    candidates.find((candidate) => candidate.value === selectedValue) ?? null;

  // The model is written last, once the route that serves it is settled, so
  // the editor derives the profile's Name from the model's display name under
  // the provider that will dispatch it. Doing it here rather than in the click
  // handler is what makes the ordering hold: the handler's view of the editor
  // predates its own provider change, while this runs after it lands.
  useEffect(() => {
    if (!selectedCandidate?.connected) {
      return;
    }
    if (editor.provider !== selectedCandidate.provider) {
      return;
    }
    if (editor.model === selectedCandidate.modelId) {
      return;
    }
    editor.handleModelChange(selectedCandidate.modelId);
  }, [selectedCandidate, editor]);

  function selectCandidate(candidate: ProviderCandidate): void {
    setSelectedValue(candidate.value);
    if (editor.provider !== candidate.provider) {
      editor.handleProviderChange(candidate.provider);
      // A named row carries its own binding; the provider change above has
      // already resolved a lone connection for the bare row.
      if (candidate.connectionName !== "") {
        editor.setProviderConnection(candidate.connectionName);
      }
    } else {
      // Re-picking the kind's bare row means "the default entry", so the
      // explicit binding clears.
      editor.setProviderConnection(candidate.connectionName);
    }
    if (!candidate.connected) {
      // Nothing can dispatch this route yet. The model stays unset so Save
      // is blocked until the connect form below produces a connection.
      editor.setModel("");
      setSetupOpenFor(candidate.value);
      return;
    }
    setSetupOpenFor(null);
  }

  function selectByValue(value: string): void {
    const candidate = candidates.find((entry) => entry.value === value);
    if (candidate) {
      selectCandidate(candidate);
    }
  }

  function openCandidatesFor(next: ModelDraft): void {
    setDraft(next);
    const nextCandidates =
      next.kind === "catalog"
        ? (options.find((option) => option.displayName === next.displayName)
            ?.candidates ?? [])
        : next.kind === "custom"
          ? customModelProviderCandidates(resolverInput, next.modelId)
          : [];
    const candidate = defaultProviderCandidate(nextCandidates);
    if (candidate) {
      selectCandidate(candidate);
      return;
    }
    setSelectedValue("");
  }

  function handleModelPick(value: string): void {
    if (value === CUSTOM_MODEL_OPTION_VALUE) {
      editor.setModel("");
      openCandidatesFor({ kind: "custom", modelId: "" });
      return;
    }
    if (value.startsWith(SEE_MORE_PREFIX)) {
      // Acts on the list rather than answering it, so the draft is untouched.
      const group = value.slice(SEE_MORE_PREFIX.length);
      setUnfoldedGroups((previous) =>
        previous.includes(group)
          ? previous.filter((key) => key !== group)
          : [...previous, group],
      );
      return;
    }
    openCandidatesFor({ kind: "catalog", displayName: value });
  }

  function handleCustomModelIdChange(value: string): void {
    setDraft({ kind: "custom", modelId: value });
  }

  function handleConnectFormCancel(): void {
    const fallback = candidates.find((candidate) => candidate.connected);
    if (fallback) {
      selectCandidate(fallback);
      return;
    }
    // Nothing else can serve this model, so the route stays selected and only
    // its form collapses. The card's own setup action reopens it.
    setSetupOpenFor(null);
  }

  function openSetupFor(value: string): void {
    const candidate = candidates.find((entry) => entry.value === value);
    if (!candidate) {
      return;
    }
    if (selectedValue !== candidate.value) {
      selectCandidate(candidate);
    }
    setSetupOpenFor(candidate.value);
  }

  const modelOptions = useMemo<SearchableSelectOption[]>(() => {
    const rows: SearchableSelectOption[] = [];
    const modelRow = (
      option: ModelFirstOption,
      group: string,
      state: ModelRowState,
    ): SearchableSelectOption => ({
      value: option.displayName,
      label: option.displayName,
      group,
      folded: state === "folded",
      disclosed: state === "disclosed",
    });
    for (const group of groups) {
      const { shown, hidden } = collapseSectionRows(group.options);
      const unfolded = unfoldedGroups.includes(group.key);
      for (const option of shown) {
        rows.push(modelRow(option, group.label, "current"));
      }
      for (const option of hidden) {
        // Folded away while the list is being browsed, but never hidden from
        // a query: someone who types a model's name means that model.
        rows.push(
          modelRow(option, group.label, unfolded ? "disclosed" : "folded"),
        );
      }
      if (hidden.length > 0) {
        rows.push({
          value: `${SEE_MORE_PREFIX}${group.key}`,
          label: unfolded
            ? t("profileCreateModelFirst.seeLess")
            : t("profileCreateModelFirst.seeMore"),
          group: group.label,
          listAction: true,
          expanded: unfolded,
        });
      }
    }
    rows.push({
      value: CUSTOM_MODEL_OPTION_VALUE,
      label: t("profileCreateModelFirst.customModelOption"),
      // The catalog outgrows the menu's height, so the escape hatch is
      // pinned rather than left at the end of a scroll.
      sticky: true,
    });
    return rows;
  }, [groups, unfoldedGroups, t]);

  const fieldLabelClass =
    "block text-body-small-default text-[var(--content-tertiary)]";

  // Held for as long as there is a list to open, which is every state but the
  // custom id, where free text has replaced it. It cannot be held only until
  // a model is picked: the field outlives the question, and reopening it in a
  // dialog that had given the room back is what put the list over the footer.
  // How much is held is the part that changes. While the field is the whole
  // of the dialog the list gets the height it is meant to be read at; once
  // the answer stands under it, the room drops to the least the list can be
  // reopened at, so what the flow gained is not paid for in white space. The
  // test is never whether the list happens to be open, which would grow and
  // shrink the dialog under the user as they browse it.
  const roomForList =
    !menuBoundary || draft.kind === "custom"
      ? null
      : draft.kind === "none"
        ? MODEL_LIST_ROOM
        : MODEL_LIST_MIN_ROOM;

  // The list opens on the field's own focus, and the room above is held for
  // it, so a field nothing focused opens the dialog on an empty box. The
  // dialog's own opening focus does land here, but the surface that opened it
  // takes the focus back: the composer's profile menu restores focus to its
  // trigger as it closes, on a timer queued before this effect runs. Claiming
  // the field on a later turn is what outlasts that restore. Only where the
  // room is reserved, which is the dialog; the sidepanel is full height and
  // reserves none.
  const modelFieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuBoundary) {
      return;
    }
    let selection = 0;
    const claim = setTimeout(() => {
      const field = modelFieldRef.current?.querySelector("input");
      if (!field) {
        return;
      }
      field.focus();
      // The field selects what it holds on focus, and WebKit drops a
      // selection made during a programmatic focus, so a seeded model name is
      // taken again on the next frame. The first keystroke over it then
      // starts a query instead of editing a name nobody meant to edit. See
      // `docs/CAPACITOR.md`.
      selection = requestAnimationFrame(() => {
        field.setSelectionRange(0, field.value.length);
      });
    }, 0);
    return () => {
      clearTimeout(claim);
      cancelAnimationFrame(selection);
    };
  }, [menuBoundary]);

  return (
    <div
      className="space-y-4"
      data-testid="model-first-fields"
      style={roomForList === null ? undefined : { minHeight: roomForList }}
    >
      <div className="space-y-1" ref={modelFieldRef}>
        <label className={fieldLabelClass}>
          {t("profileCreateModelFirst.modelLabel")}
        </label>
        {draft.kind === "custom" ? (
          <>
            <Input
              value={draft.modelId}
              onChange={(event) =>
                handleCustomModelIdChange(event.target.value)
              }
              placeholder={t(
                "profileCreateModelFirst.customModelPlaceholder",
              )}
              aria-label={t("profileCreateModelFirst.customModelAriaLabel")}
              fullWidth
              autoFocus
            />
            <Button
              variant="link"
              size="compact"
              onClick={() => {
                editor.setModel("");
                openCandidatesFor(NO_MODEL);
              }}
            >
              {t("profileCreateModelFirst.chooseFromList")}
            </Button>
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("profileCreateModelFirst.customModelHint")}
            </Typography>
          </>
        ) : (
          <SearchableSelect
            value={draft.kind === "catalog" ? draft.displayName : ""}
            onChange={handleModelPick}
            aria-label={t("profileCreateModelFirst.modelAriaLabel")}
            placeholder={t("profileCreateModelFirst.modelPlaceholder")}
            emptyText={t("profileCreateModelFirst.modelNoMatches")}
            menuBoundary={menuBoundary}
            announceResults={(count) =>
              t("profileCreateModelFirst.modelResultsAnnouncement", { count })
            }
            options={modelOptions}
          />
        )}
      </div>

      {draft.kind !== "none" && candidates.length > 0 ? (
        <ProviderStep
          assistantId={assistantId}
          candidates={candidates}
          editor={editor}
          onCancelConnect={handleConnectFormCancel}
          onOpenSetup={openSetupFor}
          onSelect={selectByValue}
          selectedCandidate={selectedCandidate}
          setupExpanded={
            selectedCandidate !== null &&
            !selectedCandidate.connected &&
            setupOpenFor === selectedCandidate.value
          }
        />
      ) : null}
    </div>
  );
}

interface ProviderStepProps {
  assistantId: string;
  candidates: readonly ProviderCandidate[];
  editor: ProfileEditor;
  onCancelConnect: () => void;
  onOpenSetup: (value: string) => void;
  onSelect: (value: string) => void;
  selectedCandidate: ProviderCandidate | null;
  /** Whether the selected route's connect form is open. */
  setupExpanded: boolean;
}

/**
 * The flow's second question, which is asked only as far as it needs to be:
 * a lone connected route is stated rather than offered, and everything else
 * becomes a card list whose selected card carries its own connect form when
 * the route it names has no connection yet.
 */
function ProviderStep({
  assistantId,
  candidates,
  editor,
  onCancelConnect,
  onOpenSetup,
  onSelect,
  selectedCandidate,
  setupExpanded,
}: ProviderStepProps) {
  const { t } = useTranslation("settings");
  const soleCandidate = candidates.length === 1 ? candidates[0] : null;
  // Namespaces this group's radio ids, which the card's own label points at.
  const radioIdPrefix = useId();

  // Keyed by the route it connects: the create form reads its provider,
  // label, name, and credential from props once, at mount, so a section
  // reused across two routes would write the previous one's connection.
  const connectSection =
    selectedCandidate && setupExpanded ? (
      // The rule sets the form apart from the row that names the route, so
      // the form's own actions read as the form's rather than the dialog's.
      <div className="border-t border-[var(--border-subtle)] pt-3">
        <ConnectSection
          key={selectedCandidate.value}
          assistantId={assistantId}
          candidate={selectedCandidate}
          editor={editor}
          onCancel={onCancelConnect}
        />
      </div>
    ) : null;

  function setupAction(candidate: ProviderCandidate) {
    if (candidate.connected || setupExpanded) {
      return null;
    }
    return (
      <Button
        variant="link"
        size="compact"
        data-testid="candidate-setup-btn"
        onClick={() => onOpenSetup(candidate.value)}
      >
        {candidateSetupLabel(candidate, t)}
      </Button>
    );
  }

  /**
   * The route's own tag, withheld from the card whose connect form is open:
   * the form below it is already the answer to what the tag asks for, and
   * the two on one row read as two ways to do the same thing.
   */
  function candidateTag(candidate: ProviderCandidate) {
    if (setupExpanded && candidate.value === selectedCandidate?.value) {
      return null;
    }
    return <CandidateTag candidate={candidate} />;
  }

  return (
    <div className="space-y-1">
      <span
        id="profile-create-provider-label"
        className="block text-body-small-default text-[var(--content-tertiary)]"
      >
        {t("profileCreateModelFirst.providerLabel")}
      </span>

      {soleCandidate ? (
        <div className="space-y-2">
          {/* A statement, not a control: nothing here is choosable, so it
              carries no field border, no chevron and no text cursor. */}
          <div
            data-testid="provider-candidate"
            data-candidate={soleCandidate.value}
            className="flex min-h-9 cursor-default items-center justify-between gap-2 rounded-lg bg-[var(--surface-sunken)] px-3 py-2"
          >
            <Typography variant="body-medium-lighter" as="span">
              {soleCandidate.label}
            </Typography>
            {candidateTag(soleCandidate)}
          </div>
          {soleCandidate.connected ? (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-[var(--content-tertiary)]"
            >
              {t("profileCreateModelFirst.soleProviderHint", {
                name: soleCandidate.label,
              })}
            </Typography>
          ) : null}
          {setupAction(soleCandidate)}
          {connectSection}
        </div>
      ) : (
        // A custom model id is served by every route there is, so the cards
        // scroll inside a cap rather than growing the dialog past the ceiling
        // its own body sets: what the dialog asks of the window stays a
        // fraction of it whatever the list costs, its footer keeps clear of
        // the window edge, and the fade says there is more below. Inert for
        // the handful of routes a catalog model has, which never reach the
        // cap.
        <ScrollShadow className="max-h-[40vh]" size={16}>
          <RadioGroup
            value={selectedCandidate?.value ?? ""}
            onValueChange={onSelect}
            aria-labelledby="profile-create-provider-label"
          >
            {candidates.map((candidate) => {
              const selected = candidate.value === selectedCandidate?.value;
              const meta = candidateMeta(candidate, t);
              const radioId = `${radioIdPrefix}-${candidate.value}`;
              const setup = selected ? setupAction(candidate) : null;
              const connect = selected ? connectSection : null;
              return (
                <div
                  key={candidate.value}
                  data-testid="provider-candidate"
                  data-candidate={candidate.value}
                  className={`rounded-lg border ${
                    selected
                      ? "border-[var(--border-active)]"
                      : "border-[var(--border-element)]"
                  }`}
                >
                  {/* The whole row is the radio's label, so its padding and
                      the space between the name and the tag select the route
                      too. It stops at the row: a browser ignores a label
                      click that lands on interactive content, but the connect
                      form below carries labels of its own, which cannot nest
                      inside this one. */}
                  <label
                    htmlFor={radioId}
                    className={`flex min-h-9 cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 ${
                      selected ? "" : "hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Radio
                        id={radioId}
                        value={candidate.value}
                        // The label element names the whole row, tag
                        // included, so the route says its own name.
                        aria-label={
                          meta ? `${candidate.label} ${meta}` : candidate.label
                        }
                      />
                      <Typography variant="body-medium-lighter" as="span">
                        {candidate.label}
                      </Typography>
                      {meta ? <PickerMeta text={meta} /> : null}
                    </span>
                    {candidateTag(candidate)}
                  </label>
                  {/* `pt-1` over the row's own `pb-2` is the gap the card
                      keeps between the route and what it expands into. */}
                  {setup || connect ? (
                    <div className="space-y-3 px-3 pt-1 pb-2">
                      {setup}
                      {connect}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </RadioGroup>
        </ScrollShadow>
      )}

      {editor.newProviderNote ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {t("profileEditorFields.newProviderNote")}
        </Typography>
      ) : null}
    </div>
  );
}

/**
 * The row's annotation as this flow says it. The shared picker encoding calls
 * the Vellum route "Managed", which is what the provider-first picker and the
 * Providers section keep saying; a person choosing a model first is being
 * pointed at a route rather than told how it is run, so here the same row
 * reads "Recommended". Every other annotation passes through untouched.
 */
function candidateMeta(
  candidate: ProviderCandidate,
  t: TFunction<"settings">,
): string | undefined {
  if (candidate.meta && candidate.provider === VELLUM_CONNECTION_PROVIDER) {
    return t("profileCreateModelFirst.recommendedMeta");
  }
  return candidate.meta;
}

/** What an unconnected route still needs, as the tag and the action say it. */
function candidateSetupLabel(
  candidate: ProviderCandidate,
  t: TFunction<"settings">,
): string {
  if (candidate.setup === "sign-in") {
    return t("profileCreateModelFirst.signInTag");
  }
  if (candidate.setup === "set-up") {
    return t("profileCreateModelFirst.setUpTag");
  }
  return t("profileCreateModelFirst.addApiKeyTag");
}

function CandidateTag({ candidate }: { candidate: ProviderCandidate }) {
  const { t } = useTranslation("settings");
  if (candidate.connected) {
    return (
      <Tag tone="positive">{t("profileCreateModelFirst.connectedTag")}</Tag>
    );
  }
  return <Tag tone="neutral">{candidateSetupLabel(candidate, t)}</Tag>;
}

interface ConnectSectionProps {
  assistantId: string;
  candidate: ProviderCandidate;
  editor: ProfileEditor;
  onCancel: () => void;
}

/**
 * The connect flow for a route with no connection yet, inline under the card
 * that names it. Both branches report the stored connection through the
 * editor's own `handleProviderCreated`, which is the same path the
 * provider-first flow's inline create uses.
 */
function ConnectSection({
  assistantId,
  candidate,
  editor,
  onCancel,
}: ConnectSectionProps) {
  const { t } = useTranslation("settings");
  // The subscription is signed into, not created: it has no name, no key, and
  // no endpoint for the create form to collect.
  if (candidate.provider === CHATGPT_CONNECTION_PROVIDER) {
    return (
      <ChatgptOAuthSection
        assistantId={assistantId}
        onConnected={editor.handleProviderCreated}
      />
    );
  }
  return (
    <ProviderCreateForm
      variant="inline"
      assistantId={assistantId}
      existingNames={editor.effectiveConnections.map(
        (connection) => connection.name,
      )}
      connections={editor.effectiveConnections}
      defaultProviderType={candidate.provider}
      hideProviderSelect
      onCreated={editor.handleProviderCreated}
      onCancel={onCancel}
      // The dialog's own Cancel sits right below this one and abandons the
      // whole profile; this one only puts the key form away.
      cancelLabel={t("profileCreateModelFirst.cancelConnect")}
    />
  );
}
