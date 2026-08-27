import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./PageHeader.module.css";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned actions (buttons / links). */
  actions?: ReactNode;
  /** Rendered above the title — e.g. a Breadcrumbs element or a status badge. */
  eyebrow?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, eyebrow, className }: PageHeaderProps) {
  return (
    <header className={cx(styles.header, className)}>
      {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
      <div className={styles.row}>
        <div className={styles.headings}>
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
}
