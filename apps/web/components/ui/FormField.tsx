import { useId, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./FormField.module.css";

interface FormFieldProps {
  label: ReactNode;
  /** Rendered via a render-prop so the control receives the generated id + aria wiring. */
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
}

/**
 * Label + hint + error, wired to the control by id / aria-describedby /
 * aria-invalid. The control is supplied through a render-prop so the
 * wiring can't be forgotten at a call site.
 */
export function FormField({ label, children, hint, error, optional, className }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = cx(hint ? hintId : undefined, error ? errorId : undefined) || undefined;

  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {optional && <span className={styles.optional}>Optional</span>}
      </label>
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
