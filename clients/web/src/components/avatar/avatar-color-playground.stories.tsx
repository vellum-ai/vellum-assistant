/**
 * Inspect the real avatar color pipeline with either a bundled character color
 * or an image that stays in this browser tab.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type ChangeEvent,
  type CSSProperties,
  useEffect,
  useState,
} from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { ACCENT_FILL_CLASS } from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import {
  AVATAR_ACCENT_FILL_CSS_VAR,
  AVATAR_ACCENT_GLYPH_CSS_VAR,
  AVATAR_ACCENT_INK_CSS_VAR,
  avatarAccentVars,
} from "@/hooks/use-avatar-accent-var";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";
import {
  normalizeFieldHex,
  sampleAvatarAccentHex,
} from "@/utils/avatar-image-color";
import { toneForBg, type AvatarTone } from "@/utils/avatar-tone";
import type { CharacterTraits } from "@/types/avatar";
import { AVATAR_COLORS } from "@vellumai/avatar-catalog/colors";
import {
  Button,
  Select,
  type SelectOption,
  Typography,
} from "@vellumai/design-library";
import { ArrowUp } from "lucide-react";

type SampleState =
  | { status: "palette" }
  | { status: "loading" }
  | { status: "ready"; accent: string }
  | { status: "empty" };

interface UploadedImage {
  name: string;
  url: string;
}

const DEFAULT_COLOR_ID = AVATAR_COLORS[0]!.id;

const COLOR_OPTIONS: SelectOption<string>[] = AVATAR_COLORS.map((color) => ({
  value: color.id,
  label: color.id[0]!.toUpperCase() + color.id.slice(1),
  icon: (
    <span
      aria-hidden
      className="size-3 rounded-full border border-black/10"
      style={{ backgroundColor: color.hex }}
    />
  ),
}));

function paletteAccent(colorId: string): string {
  return (
    AVATAR_COLORS.find((color) => color.id === colorId)?.hex ??
    AVATAR_COLORS[0]!.hex
  );
}

function paletteTraits(colorId: string): CharacterTraits {
  return { bodyShape: "blob", eyeStyle: "curious", color: colorId };
}

function ColorValue({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="size-5 shrink-0 rounded-full border border-black/10 shadow-sm"
        style={{ background: value ?? "var(--surface-active)" }}
      />
      <div className="min-w-0">
        <Typography
          as="div"
          variant="label-small-default"
          className="text-[var(--content-secondary)]"
        >
          {label}
        </Typography>
        <Typography
          as="div"
          variant="body-small-default"
          className="break-all font-mono text-[var(--content-default)]"
        >
          {value ?? "Unavailable"}
        </Typography>
      </div>
    </div>
  );
}

function DerivedColors({ accent }: { accent: string | null }) {
  const values = accent ? avatarAccentVars(accent) : {};
  const tone = accent ? toneForBg(accent) : null;
  const fill = values[AVATAR_ACCENT_FILL_CSS_VAR] ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-[var(--border-element)] bg-[var(--surface-lift)] p-4">
        <Typography as="h2" variant="title-small">
          Avatar-derived colors
        </Typography>
        <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4">
          <ColorValue label="Raw accent" value={accent} />
          <ColorValue label="Readable fill" value={fill} />
          <ColorValue
            label="Text on fill"
            value={values[AVATAR_ACCENT_INK_CSS_VAR] ?? null}
          />
          <ColorValue
            label="Icon on fill"
            value={values[AVATAR_ACCENT_GLYPH_CSS_VAR] ?? null}
          />
          <ColorValue
            label="Voice field"
            value={accent ? normalizeFieldHex(accent) : null}
          />
          <ColorValue label="Muted text" value={tone?.fgMuted ?? null} />
        </div>
      </section>

      <TonePreview tone={tone} />
    </div>
  );
}

function TonePreview({ tone }: { tone: AvatarTone | null }) {
  if (!tone) {
    return (
      <section className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-[var(--border-element)] bg-[var(--surface-lift)] p-4 text-center">
        <Typography
          variant="body-medium-lighter"
          className="text-[var(--content-secondary)]"
        >
          No color was available to build the tone preview.
        </Typography>
      </section>
    );
  }

  return (
    <section
      className="min-h-52 rounded-xl p-5"
      style={{ background: tone.bg, color: tone.fg }}
    >
      <Typography
        as="div"
        variant="label-small-default"
        style={{ color: tone.fgMuted }}
      >
        FULL-BLEED AVATAR TONE
      </Typography>
      <Typography as="h2" variant="title-medium" className="mt-2">
        Primary text follows the avatar
      </Typography>
      <Typography
        as="p"
        variant="body-medium-lighter"
        className="mt-2"
        style={{ color: tone.fgMuted }}
      >
        Secondary text uses the shared muted foreground treatment.
      </Typography>
      <div
        className="mt-5 rounded-lg px-3 py-2"
        style={{ background: tone.bubbleBg, color: tone.bubbleFg }}
      >
        <Typography variant="body-medium-default">
          Raised content uses the derived bubble fill and text.
        </Typography>
      </div>
    </section>
  );
}

function ThemeComparison({ accent }: { accent: string | null }) {
  const vars = avatarAccentVars(accent);

  return (
    <section>
      <Typography as="h2" variant="title-small">
        Avatar color beside app theme tokens
      </Typography>
      <Typography
        as="p"
        variant="body-small-lighter"
        className="mt-1 text-[var(--content-secondary)]"
      >
        The app primary button and text tokens stay theme-owned. Only the round
        send control uses the avatar-derived fill.
      </Typography>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          <div
            key={theme}
            data-theme={theme}
            className="rounded-xl border border-[var(--border-element)] bg-[var(--surface-base)] p-4"
            style={vars as CSSProperties}
          >
            <Typography
              as="div"
              variant="label-small-default"
              className="capitalize text-[var(--content-tertiary)]"
            >
              {theme} theme
            </Typography>
            <Typography
              as="div"
              variant="body-medium-default"
              className="mt-3 text-[var(--content-default)]"
            >
              Primary app text
            </Typography>
            <Typography
              as="div"
              variant="body-small-lighter"
              className="text-[var(--content-secondary)]"
            >
              Secondary app text
            </Typography>
            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" size="compact">
                Theme primary
              </Button>
              <Button
                variant="primary"
                size="regular"
                iconOnly={<ArrowUp />}
                aria-label="Avatar-colored send control"
                className={ACCENT_FILL_CLASS}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AvatarColorSampler() {
  const [colorId, setColorId] = useState(DEFAULT_COLOR_ID);
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);
  const [sample, setSample] = useState<SampleState>({ status: "palette" });

  useEffect(() => {
    if (!uploaded) {
      return;
    }
    let active = true;
    setSample({ status: "loading" });
    void sampleAvatarAccentHex(uploaded.url).then((accent) => {
      if (!active) {
        return;
      }
      setSample(accent ? { status: "ready", accent } : { status: "empty" });
    });
    return () => {
      active = false;
      URL.revokeObjectURL(uploaded.url);
    };
  }, [uploaded]);

  const accent = uploaded
    ? sample.status === "ready"
      ? sample.accent
      : null
    : paletteAccent(colorId);

  const avatar = uploaded ? (
    <ChatAvatar
      components={null}
      traits={null}
      customImageUrl={uploaded.url}
      size={112}
    />
  ) : (
    <ChatAvatar
      components={BUNDLED_COMPONENTS}
      traits={paletteTraits(colorId)}
      customImageUrl={null}
      size={112}
    />
  );

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }
    setUploaded({ name: file.name, url: URL.createObjectURL(file) });
  };

  const resetToPalette = () => {
    setUploaded(null);
    setSample({ status: "palette" });
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <section className="grid gap-5 rounded-xl border border-[var(--border-element)] bg-[var(--surface-lift)] p-5 md:grid-cols-[auto_1fr] md:items-center">
        <div className="flex justify-center">{avatar}</div>
        <div>
          <Typography as="h1" variant="title-medium">
            Avatar color sampler
          </Typography>
          <Typography
            as="p"
            variant="body-medium-lighter"
            className="mt-1 text-[var(--content-secondary)]"
          >
            Pick a built-in color or load an image. Image pixels are sampled in
            this browser tab and are not uploaded.
          </Typography>

          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,240px)_1fr] sm:items-end">
            <Select
              label="Built-in assistant color"
              options={COLOR_OPTIONS}
              value={colorId}
              onChange={(next) => {
                setColorId(next);
                resetToPalette();
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outlined">
                <label>
                  Load custom avatar
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/*"
                    onChange={handleFile}
                  />
                </label>
              </Button>
              {uploaded && (
                <Button variant="ghost" onClick={resetToPalette}>
                  Use built-in color
                </Button>
              )}
            </div>
          </div>

          {uploaded && (
            <Typography
              as="p"
              variant="body-small-lighter"
              className="mt-3 text-[var(--content-secondary)]"
              aria-live="polite"
            >
              {sample.status === "loading"
                ? `Sampling ${uploaded.name}...`
                : sample.status === "empty"
                  ? `No color could be sampled from ${uploaded.name}.`
                  : `Sampled locally from ${uploaded.name}.`}
            </Typography>
          )}
        </div>
      </section>

      <DerivedColors accent={accent} />
      <ThemeComparison accent={accent} />
    </main>
  );
}

function PaletteMatrix() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {AVATAR_COLORS.map((color) => {
        const vars = avatarAccentVars(color.hex);
        const tone = toneForBg(color.hex);
        return (
          <article
            key={color.id}
            className="overflow-hidden rounded-xl border border-[var(--border-element)] bg-[var(--surface-lift)]"
          >
            <div
              className="flex items-center gap-3 p-4"
              style={{ background: tone.bg, color: tone.fg }}
            >
              <ChatAvatar
                components={BUNDLED_COMPONENTS}
                traits={paletteTraits(color.id)}
                customImageUrl={null}
                size={56}
              />
              <div>
                <Typography
                  as="h2"
                  variant="title-small"
                  className="capitalize"
                >
                  {color.id}
                </Typography>
                <Typography
                  as="div"
                  variant="body-small-lighter"
                  style={{ color: tone.fgMuted }}
                >
                  {color.hex}
                </Typography>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4">
              <ColorValue
                label="Readable fill"
                value={vars[AVATAR_ACCENT_FILL_CSS_VAR] ?? null}
              />
              <ColorValue
                label="Text on fill"
                value={vars[AVATAR_ACCENT_INK_CSS_VAR] ?? null}
              />
              <ColorValue
                label="Icon on fill"
                value={vars[AVATAR_ACCENT_GLYPH_CSS_VAR] ?? null}
              />
              <ColorValue
                label="Voice field"
                value={normalizeFieldHex(color.hex)}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

const meta = {
  title: "Components/Avatar/ColorSampler",
  parameters: { layout: "padded" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Pick a bundled color or sample a local image through the production pipeline. */
export const Playground: Story = {
  render: () => <AvatarColorSampler />,
};

/** The six bundled assistant colors and the treatments derived from each. */
export const BuiltInPalette: Story = {
  render: () => <PaletteMatrix />,
};
