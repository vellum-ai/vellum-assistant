import { Check, ChevronDown } from "lucide-react";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../utils/cn.js";
import { usePortalContainer } from "../utils/portal-container.js";

export interface DropdownMenuPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export type DropdownMenuAlign = "start" | "end";

export interface DropdownOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: ReactNode;
}

export interface DropdownProps<T extends string> {
  readonly options: ReadonlyArray<DropdownOption<T>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly id?: string;
  readonly name?: string;
  readonly menuMaxHeight?: number;
  readonly menuMinWidth?: number;
  readonly menuAlign?: DropdownMenuAlign;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  readonly "data-testid"?: string;
}

/**
 * Single-select dropdown for choosing a text item.
 *
 * Generic over `T extends string` so callers can narrow selection to a union
 * of literal values (e.g. `"managed" | "your-own"`) and get a typed
 * `onChange` callback. Visuals follow semantic tokens (`--surface-lift`,
 * `--border-base`, etc.) and mirror the desktop dropdown behavior.
 *
 * The menu is portaled into the element provided by the nearest
 * `<PortalContainerProvider>` so it escapes ancestor `overflow: hidden` and
 * design tokens resolve correctly. Falls back to inline rendering when no
 * provider is mounted.
 */
export function Dropdown<T extends string>({
  options,
  value,
  onChange,
  placeholder,
  disabled = false,
  className,
  style,
  id,
  name,
  menuMaxHeight = 280,
  menuMinWidth = 0,
  menuAlign = "start",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "data-testid": dataTestId,
}: DropdownProps<T>) {
  const portalContainer = usePortalContainer();
  const autoId = useId();
  const triggerId = id ?? `dropdown-${autoId}`;
  const listboxId = `${triggerId}-listbox`;

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuPosition, setMenuPosition] =
    useState<DropdownMenuPosition | null>(null);

  const selectedIndex = useMemo(
    () => options.findIndex((option) => option.value === value),
    [options, value],
  );
  const selectedOption =
    selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setIsOpen(false);
    setHighlightedIndex(-1);
  }, []);

  const open = useCallback(() => {
    if (disabled) {
      return;
    }
    setIsOpen(true);
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [disabled, selectedIndex]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideContainer = containerRef.current?.contains(target);
      const insideMenu = menuRef.current?.contains(target);
      if (!insideContainer && !insideMenu) {
        close();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, close]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      setMenuPosition(
        resolveDropdownMenuPosition(
          {
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
          },
          {
            align: menuAlign,
            minWidth: menuMinWidth,
            viewportWidth: window.innerWidth,
          },
        ),
      );
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, menuAlign, menuMinWidth]);

  useEffect(() => {
    if (!isOpen || highlightedIndex < 0) {
      return;
    }
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const item = menu.children[highlightedIndex];
    if (item instanceof HTMLElement) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, highlightedIndex]);

  const selectOption = useCallback(
    (option: DropdownOption<T>) => {
      onChange(option.value);
      close();
      triggerRef.current?.focus();
    },
    [onChange, close],
  );

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) {
        return;
      }
      if (!isOpen) {
        if (
          event.key === "ArrowDown" ||
          event.key === "ArrowUp" ||
          event.key === "Enter" ||
          event.key === " "
        ) {
          event.preventDefault();
          open();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((prev: number) => {
          const next = prev + 1;
          return next >= options.length ? 0 : next;
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((prev: number) => {
          const next = prev - 1;
          return next < 0 ? options.length - 1 : next;
        });
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setHighlightedIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setHighlightedIndex(options.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const target = options[highlightedIndex];
        if (target) {
          selectOption(target);
        }
      }
    },
    [disabled, isOpen, open, close, options, highlightedIndex, selectOption],
  );

  const activeId =
    isOpen && highlightedIndex >= 0
      ? `${triggerId}-option-${highlightedIndex}`
      : undefined;

  const handleContainerBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!isOpen) {
        return;
      }
      const nextFocus = event.relatedTarget as Node | null;
      if (!nextFocus) {
        close();
        return;
      }
      const insideContainer = containerRef.current?.contains(nextFocus);
      const insideMenu = menuRef.current?.contains(nextFocus);
      if (insideContainer || insideMenu) {
        return;
      }
      close();
    },
    [isOpen, close],
  );

  const menuNode = isOpen && menuPosition ? (
    <ul
      ref={menuRef}
      id={listboxId}
      role="listbox"
      aria-labelledby={ariaLabelledBy ?? triggerId}
      tabIndex={-1}
      data-slot="dropdown-menu"
      className="pointer-events-auto fixed z-50 mt-1 overflow-auto rounded-md border bg-[var(--field-bg)] py-1 shadow-xl focus:outline-none"
      style={{
        borderColor: "var(--field-border)",
        maxHeight: menuMaxHeight,
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
      }}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const isHighlighted = index === highlightedIndex;
        return (
          <li
            key={option.value}
            id={`${triggerId}-option-${index}`}
            role="option"
            aria-selected={isSelected}
            data-slot="dropdown-option"
            onMouseEnter={() => setHighlightedIndex(index)}
            onMouseDown={(event: ReactMouseEvent) => {
              event.preventDefault();
            }}
            onClick={() => selectOption(option)}
            className="flex cursor-pointer items-center gap-2 px-3 py-2 text-body-medium-default transition-colors"
            style={{
              background: isHighlighted
                ? "var(--surface-hover)"
                : "transparent",
              color: "var(--content-default)",
            }}
          >
            {option.icon && (
              <span
                className="flex shrink-0 items-center"
                style={{ color: "var(--content-tertiary)" }}
                aria-hidden
              >
                {option.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">
              {option.label}
            </span>
            {isSelected && (
              <Check
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: "var(--system-positive-strong)" }}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ul>
  ) : null;

  return (
    <div
      ref={containerRef}
      data-slot="dropdown"
      className={cn("relative", className)}
      style={style}
      onBlur={handleContainerBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        name={name}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={disabled}
        disabled={disabled}
        data-testid={dataTestId}
        data-slot="dropdown-trigger"
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={handleTriggerKeyDown}
        className="flex h-9 w-full items-center gap-2 rounded-md border bg-[var(--field-bg)] px-3 text-left text-body-medium-lighter transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          borderColor: isOpen
            ? "var(--border-active)"
            : "var(--field-border)",
          color: selectedOption
            ? "var(--content-default)"
            : "var(--content-tertiary)",
        }}
      >
        {selectedOption?.icon && (
          <span
            className="flex shrink-0 items-center"
            style={{ color: "var(--content-tertiary)" }}
            aria-hidden
          >
            {selectedOption.icon}
          </span>
        )}
        <span className="flex-1 truncate">
          {selectedOption?.label ?? placeholder ?? ""}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--content-tertiary)" }}
          aria-hidden
        />
      </button>

      {menuNode && portalContainer
        ? createPortal(menuNode, portalContainer)
        : menuNode}
    </div>
  );
}

export function resolveDropdownMenuPosition(
  trigger: {
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
  },
  options: {
    readonly minWidth?: number;
    readonly align?: DropdownMenuAlign;
    readonly viewportWidth?: number;
  } = {},
): DropdownMenuPosition {
  const width = Math.max(trigger.width, options.minWidth ?? 0);
  const align = options.align ?? "start";
  const viewportWidth = options.viewportWidth;
  let left = align === "end" ? trigger.right - width : trigger.left;

  if (viewportWidth !== undefined && left + width > viewportWidth) {
    left = viewportWidth - width;
  }

  return {
    left: Math.max(0, left),
    top: trigger.bottom,
    width,
  };
}
