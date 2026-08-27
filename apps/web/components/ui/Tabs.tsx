"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./Tabs.module.css";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Small trailing count / dot, e.g. number of configured rows. */
  badge?: ReactNode;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** Accessible name for the tablist. */
  label: string;
  /** Shared id prefix — pass the same value to tabPanelProps so panels wire back to their tab. */
  idBase: string;
  className?: string;
}

/**
 * Accessible tablist with roving arrow-key navigation. The tab strip
 * scrolls horizontally when it overflows (mobile) rather than wrapping.
 * Panels are rendered by the caller; each panel should have
 * id={panelId(active)} and aria-labelledby={tabId(active)} — use the
 * exported helpers.
 */
export function Tabs({ tabs, active, onChange, label, idBase, className }: TabsProps) {
  const base = idBase;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.id === active);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    const id = tabs[next].id;
    onChange(id);
    refs.current[id]?.focus();
  }

  return (
    <div className={cx(styles.scroller, className)}>
      <div role="tablist" aria-label={label} aria-orientation="horizontal" className={styles.tablist} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={cx(styles.tab, selected && styles.active)}
              onClick={() => onChange(tab.id)}
            >
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== null && <span className={styles.badge}>{tab.badge}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Panel a11y props — pass the same `base` value given to <Tabs idBase>. */
export function tabPanelProps(base: string, id: string, active: string) {
  return {
    role: "tabpanel" as const,
    id: `${base}-panel-${id}`,
    "aria-labelledby": `${base}-tab-${id}`,
    hidden: id !== active,
  };
}
