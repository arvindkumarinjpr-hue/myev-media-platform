"use client";

import { useState } from "react";
import styles from "./JsonField.module.css";

/** A raw-JSON textarea for the backend's genuinely-unstructured JSONB columns (industry_profile, publishing_strategy, terminology, etc.) — the simplest honest editor for a field with no fixed shape, rather than inventing a form builder for something the architecture deliberately left schema-less. */
export function JsonField({
  id,
  label,
  value,
  onChange,
  readOnly,
}: {
  id: string;
  label: string;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  function handleChange(next: string) {
    setText(next);
    try {
      const parsed = JSON.parse(next || "{}");
      setParseError(null);
      onChange(parsed);
    } catch {
      setParseError("Not valid JSON — changes here won't be saved until this is fixed.");
    }
  }

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        readOnly={readOnly}
        rows={5}
        className={styles.textarea}
        spellCheck={false}
      />
      {parseError && <p className={styles.error}>{parseError}</p>}
    </div>
  );
}
