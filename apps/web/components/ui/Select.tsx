import { forwardRef, type SelectHTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { ChevronDownIcon } from "./icons";
import styles from "./Select.module.css";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <span className={styles.wrap}>
      <select
        ref={ref}
        className={cx(styles.select, invalid && styles.invalid, className)}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon className={styles.chevron} />
    </span>
  );
});
