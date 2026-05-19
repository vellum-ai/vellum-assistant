
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "@vellum/design-library/components/popover";
import { useAuth } from "@/lib/auth.js";
import { useOrganization } from "@/lib/organization/organization-provider.js";

export function OrganizationSelector() {
  const { isAdmin, isLoggedIn } = useAuth();
  const {
    currentOrganizationId,
    organizations,
    setCurrentOrganizationId,
    status,
  } = useOrganization();
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const listboxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const getInitialFocusIndex = useCallback(() => {
    const activeIndex = organizations.findIndex(
      (org) => org.id === currentOrganizationId
    );
    return activeIndex >= 0 ? activeIndex : 0;
  }, [organizations, currentOrganizationId]);

  const openDropdown = useCallback(() => {
    setOpen(true);
    setFocusedIndex(getInitialFocusIndex());
  }, [getInitialFocusIndex]);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setFocusedIndex(-1);
  }, []);

  const selectAndClose = useCallback(
    (orgId: string) => {
      setCurrentOrganizationId(orgId);
      closeDropdown();
      triggerRef.current?.focus();
    },
    [setCurrentOrganizationId, closeDropdown]
  );

  const handleTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp":
        case "Enter":
        case " ":
          e.preventDefault();
          if (!open) {
            openDropdown();
          }
          break;
        case "Escape":
          if (open) {
            e.preventDefault();
            closeDropdown();
          }
          break;
      }
    },
    [open, openDropdown, closeDropdown]
  );

  const handleListboxKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev < organizations.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev > 0 ? prev - 1 : organizations.length - 1
          );
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          {
            const org = organizations[focusedIndex];
            if (org) {
              selectAndClose(org.id);
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          closeDropdown();
          triggerRef.current?.focus();
          break;
        case "Home":
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setFocusedIndex(organizations.length - 1);
          break;
      }
    },
    [organizations, focusedIndex, selectAndClose, closeDropdown]
  );

  // Focus the listbox when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        listboxRef.current?.focus();
      });
    }
  }, [open]);

  // Scroll focused option into view
  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    const listbox = listboxRef.current;
    if (!listbox) return;
    const options = listbox.querySelectorAll('[role="option"]');
    const focusedOption = options[focusedIndex] as HTMLElement | undefined;
    focusedOption?.scrollIntoView({ block: "nearest" });
  }, [open, focusedIndex]);

  if (!isLoggedIn || status !== "ready") {
    return null;
  }

  const shouldShowSelector = isAdmin || organizations.length > 1;
  if (!shouldShowSelector || !currentOrganizationId) {
    return null;
  }

  const currentOrg = organizations.find(
    (org) => org.id === currentOrganizationId
  );

  const focusedOrg =
    focusedIndex >= 0 ? organizations[focusedIndex] : undefined;
  const activeDescendantId =
    open && focusedOrg ? `org-option-${focusedOrg.id}` : undefined;

  return (
    <div className="hidden items-center gap-2 md:flex">
      <span className="text-body-small-default uppercase tracking-wide text-(--content-secondary)">
        Org
      </span>
      <Popover.Root
        open={open}
        onOpenChange={(next) => (next ? openDropdown() : closeDropdown())}
      >
        <Popover.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            onKeyDown={handleTriggerKeyDown}
            className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-(--border-base) bg-(--surface-base) px-3 py-1.5 text-body-medium-lighter text-(--content-default) transition-colors hover:bg-(--ghost-hover)"
            aria-label="Active organization"
            aria-expanded={open}
            aria-haspopup="listbox"
          >
            {currentOrg?.name ?? ""}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
        </Popover.Trigger>
        <Popover.Content
          ref={listboxRef}
          align="end"
          sideOffset={4}
          role="listbox"
          aria-label="Select organization"
          aria-activedescendant={activeDescendantId}
          tabIndex={0}
          onKeyDown={handleListboxKeyDown}
          onCloseAutoFocus={(e) => {
            // Keep focus control so that the trigger ref.focus() calls from
            // selectAndClose / Escape handlers still land on the trigger
            // button without Radix's default auto-focus fighting us.
            e.preventDefault();
          }}
          className="min-w-[200px] py-1 px-0"
        >
          {organizations.map((organization, index) => {
            const isActive = organization.id === currentOrganizationId;
            const isFocused = index === focusedIndex;
            return (
              <div
                key={organization.id}
                id={`org-option-${organization.id}`}
                role="option"
                aria-selected={isActive}
                tabIndex={-1}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-body-medium-lighter text-(--content-default) transition-colors hover:bg-(--ghost-hover) ${
                  isActive && !isFocused ? "bg-(--ghost-hover)" : ""
                } ${isFocused ? "bg-(--ghost-hover) outline outline-2 -outline-offset-2 outline-(--border-base)" : ""}`}
                onClick={() => selectAndClose(organization.id)}
                onMouseEnter={() => setFocusedIndex(index)}
              >
                <span className="flex-1">{organization.name}</span>
                {isActive && (
                  <Check className="h-4 w-4 text-(--content-secondary)" />
                )}
              </div>
            );
          })}
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}
