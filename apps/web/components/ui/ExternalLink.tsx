import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { ExternalLinkIcon } from "./icons";
import styles from "./ExternalLink.module.css";

interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/** Outbound link — opens in a new tab safely, shows an external-link icon, and announces the new-tab behaviour to assistive tech. */
export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cx(styles.link, className)}
    >
      <span className={styles.label}>{children}</span>
      <ExternalLinkIcon className={styles.icon} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Best-effort readable label for a URL — the hostname without a leading www. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
