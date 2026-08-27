import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./Card.module.css";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Removes the default inner padding — for cards whose content manages its own (e.g. a table). */
  flush?: boolean;
  children: ReactNode;
}

export function Card({ flush = false, className, children, ...rest }: CardProps) {
  return (
    <div className={cx(styles.card, flush && styles.flush, className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.header, className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cx(styles.title, className)} {...rest}>
      {children}
    </h2>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx(styles.body, className)} {...rest}>
      {children}
    </div>
  );
}
