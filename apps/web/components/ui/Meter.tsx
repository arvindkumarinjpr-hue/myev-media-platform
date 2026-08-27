import { cx } from "../../lib/cx";
import styles from "./Meter.module.css";

interface MeterProps {
  /** Current value. */
  value: number;
  max?: number;
  /** Accessible label, e.g. "Opportunity score". */
  label: string;
  /** Show the numeric value next to the bar. */
  showValue?: boolean;
  tone?: "brand" | "neutral";
  className?: string;
}

/**
 * A small proportion bar with a real `role="meter"` and a spoken value —
 * used for opportunity / confidence scores. Not a progress bar (the work
 * isn't ongoing) and never implies precision the data doesn't have.
 */
export function Meter({ value, max = 100, label, showValue = true, tone = "brand", className }: MeterProps) {
  const clamped = Math.max(0, Math.min(value, max));
  const pct = max === 0 ? 0 : Math.round((clamped / max) * 100);

  return (
    <span className={cx(styles.wrap, className)}>
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={`${clamped} out of ${max}`}
        className={styles.track}
      >
        <span className={cx(styles.fill, styles[tone])} style={{ width: `${pct}%` }} />
      </span>
      {showValue && <span className={styles.value}>{clamped}</span>}
    </span>
  );
}
