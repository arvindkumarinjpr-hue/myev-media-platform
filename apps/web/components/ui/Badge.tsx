import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "brand";

interface BadgeProps {
  tone?: BadgeTone;
  /** Adds a leading dot — useful when the badge conveys a live status. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function Badge({ tone = "neutral", dot = false, children, className }: BadgeProps) {
  return (
    <span className={cx(styles.badge, styles[tone], className)}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
