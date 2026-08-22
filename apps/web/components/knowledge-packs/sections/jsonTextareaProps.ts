import type { ChangeEvent } from "react";
import styles from "./ListSectionShell.module.css";

/**
 * A fully-controlled JSON textarea for row-embedded use — deliberately
 * NOT the stateful JsonField component (its buffered "let me type invalid
 * JSON mid-edit" internal state would go stale across add/remove inside a
 * growable list keyed by index, since removing an earlier row shifts
 * every later row's identity). This one only ever reflects the row's
 * actual current value and silently ignores an invalid keystroke rather
 * than committing it — correct at the cost of the mid-typing affordance,
 * which matters far less for an occasionally-edited sub-field than for
 * the pack-level industry profile / publishing strategy fields.
 */
export function jsonTextareaProps(value: Record<string, unknown>, onChange: (next: Record<string, unknown>) => void, readOnly: boolean, placeholder: string) {
  return {
    value: JSON.stringify(value),
    readOnly,
    placeholder,
    className: styles.textInput,
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
      try {
        onChange(JSON.parse(e.target.value || "{}"));
      } catch {
        // Invalid mid-edit JSON — ignored, not committed; the field stays
        // at its last valid value until the input parses again.
      }
    },
  };
}
