"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { cx } from "../../lib/cx";
import { CloseIcon } from "./icons";
import styles from "./ChipsInput.module.css";

interface ChipsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
  placeholder?: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-label"?: string;
}

/**
 * Token/chip editor for string lists (channels, keywords). Commit a chip
 * with Enter or comma; Backspace on an empty field removes the last chip.
 * Duplicates and blanks are ignored.
 */
export function ChipsInput({
  value,
  onChange,
  readOnly,
  placeholder,
  id,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
}: ChipsInputProps) {
  const [draft, setDraft] = useState("");
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  function commit(raw: string) {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  if (readOnly) {
    return (
      <div className={styles.readonly}>
        {value.length === 0 ? <span className={styles.none}>—</span> : value.map((chip) => <span key={chip} className={styles.chip}>{chip}</span>)}
      </div>
    );
  }

  return (
    <div className={cx(styles.wrap)}>
      {value.map((chip, i) => (
        <span key={chip} className={styles.chip}>
          {chip}
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove ${chip}`}
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
          >
            <CloseIcon />
          </button>
        </span>
      ))}
      <input
        id={inputId}
        className={styles.input}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}
