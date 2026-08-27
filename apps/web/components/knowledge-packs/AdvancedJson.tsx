"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Textarea } from "../ui/Textarea";
import styles from "./AdvancedJson.module.css";

function pretty(value: Record<string, unknown>): string {
  return Object.keys(value).length === 0 ? "{\n}" : JSON.stringify(value, null, 2);
}

interface AdvancedJsonProps {
  /** The complete object being edited — structured fields above edit the same object. */
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  readOnly?: boolean;
  /** e.g. "industry profile" — used in the summary + helper copy. */
  noun: string;
  /** Keys the structured form above already covers — used only for the "N extra fields" hint. */
  knownKeys?: string[];
}

/**
 * Collapsed-by-default advanced escape hatch for a schema-less JSON
 * object. It edits the WHOLE object, so any key the structured fields
 * above don't know about is shown here and is never silently dropped —
 * structured edits merge into the same object, they don't replace it.
 * A normal user never needs to open this.
 */
export function AdvancedJson({ value, onChange, readOnly, noun, knownKeys = [] }: AdvancedJsonProps) {
  const id = useId();
  const [text, setText] = useState(() => pretty(value));
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef(JSON.stringify(value));

  // Re-sync the buffer when the object changes from elsewhere (a
  // structured field edit) — but not while echoing our own last edit.
  useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming !== lastEmitted.current) {
      setText(pretty(value));
      lastEmitted.current = incoming;
      setError(null);
    }
  }, [value]);

  function handleChange(next: string) {
    setText(next);
    let parsed: unknown;
    try {
      parsed = JSON.parse(next.trim() || "{}");
    } catch {
      setError("Not valid JSON — fix this to apply the changes.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Must be a JSON object, e.g. { \"key\": \"value\" }.");
      return;
    }
    setError(null);
    lastEmitted.current = JSON.stringify(parsed);
    onChange(parsed as Record<string, unknown>);
  }

  const extraKeys = Object.keys(value).filter((k) => !knownKeys.includes(k));

  return (
    <details className={styles.details}>
      <summary className={styles.summary}>
        Advanced — edit the raw {noun}
        {extraKeys.length > 0 && <span className={styles.count}>{extraKeys.length} extra field{extraKeys.length === 1 ? "" : "s"}</span>}
      </summary>
      <div className={styles.body}>
        <p className={styles.help}>
          For fields the form above doesn&apos;t cover. Everything here is saved as-is; the structured fields and this editor
          change the same data.
        </p>
        <Textarea
          id={id}
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          readOnly={readOnly}
          spellCheck={false}
          rows={6}
          className={styles.editor}
          invalid={!!error}
          aria-label={`Raw ${noun} JSON`}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {error && (
          <p id={`${id}-err`} className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
