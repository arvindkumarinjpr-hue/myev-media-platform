import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { AlertIcon, InfoIcon } from "./icons";
import styles from "./Alert.module.css";

export type AlertTone = "info" | "success" | "warning" | "danger";

interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Trailing action (e.g. a Retry button). */
  action?: ReactNode;
  /** ARIA role — "alert" for errors that appear in response to an action, "status" otherwise. */
  role?: "alert" | "status";
  className?: string;
}

export function Alert({ tone = "info", title, children, action, role, className }: AlertProps) {
  const resolvedRole = role ?? (tone === "danger" ? "alert" : "status");
  return (
    <div className={cx(styles.alert, styles[tone], className)} role={resolvedRole}>
      <span className={styles.icon}>{tone === "info" || tone === "success" ? <InfoIcon /> : <AlertIcon />}</span>
      <div className={styles.content}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.body}>{children}</div>}
      </div>
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
