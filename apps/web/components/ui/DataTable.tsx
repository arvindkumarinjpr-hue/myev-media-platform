import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./DataTable.module.css";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "start" | "end";
  /** Hint used only for the mobile stacked layout — the row label shown before the value. */
  label?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption?: string;
  className?: string;
}

/**
 * A single accessible table that reflows to a stacked card list below the
 * `sm` breakpoint (each cell prefixed with its column label). Wrap-free:
 * the table scrolls inside its own container on wider-but-still-narrow
 * viewports.
 */
export function DataTable<T>({ columns, rows, rowKey, caption, className }: DataTableProps<T>) {
  return (
    <div className={cx(styles.scroll, className)}>
      <table className={styles.table}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} scope="col" className={col.align === "end" ? styles.end : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  data-label={col.label ?? (typeof col.header === "string" ? col.header : undefined)}
                  className={col.align === "end" ? styles.end : undefined}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
