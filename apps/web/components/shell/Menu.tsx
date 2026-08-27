"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./Menu.module.css";

interface MenuProps {
  /** Render-prop for the trigger; receives the props it must spread onto a <button>. */
  trigger: (props: {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
    onClick: () => void;
    ref: React.Ref<HTMLButtonElement>;
  }) => ReactNode;
  children: ReactNode;
  /** Panel alignment relative to the trigger. */
  align?: "start" | "end";
  /** Where the panel opens — "up" for a bottom-of-sidebar account menu. */
  side?: "down" | "up";
  label: string;
  className?: string;
}

/**
 * Small disclosure menu: outside-click and Escape close it, focus returns
 * to the trigger on close. Menu content is arbitrary (links, buttons) —
 * callers pass role="menuitem" elements as children.
 */
export function Menu({ trigger, children, align = "start", side = "down", label, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={cx(styles.wrap, className)}>
      {trigger({
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": panelId,
        onClick: () => setOpen((v) => !v),
        ref: triggerRef,
      })}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label={label}
          className={cx(styles.panel, styles[align], styles[side])}
          onClick={(e) => {
            // Close when a menu item is activated (links/buttons bubble here).
            if ((e.target as HTMLElement).closest("[role='menuitem']")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
