import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./Input.module.css";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Decorative leading icon (e.g. a mail/lock glyph). Purely visual — pass
   * an aria-hidden icon component. When omitted the input renders exactly
   * as before, so existing call sites are unaffected. */
  iconLeft?: ReactNode;
  /** Trailing slot for an inline control, e.g. a show/hide-password
   * toggle button. The caller owns its own accessible name/behaviour. */
  endAdornment?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, iconLeft, endAdornment, ...rest },
  ref,
) {
  const hasIconLeft = Boolean(iconLeft);
  const hasEndAdornment = Boolean(endAdornment);

  const input = (
    <input
      ref={ref}
      className={cx(
        styles.input,
        invalid && styles.invalid,
        hasIconLeft && styles.hasIconLeft,
        hasEndAdornment && styles.hasEndAdornment,
        !hasIconLeft && !hasEndAdornment && className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );

  if (!hasIconLeft && !hasEndAdornment) return input;

  return (
    <span className={cx(styles.wrap, className)}>
      {iconLeft && (
        <span className={styles.iconLeft} aria-hidden="true">
          {iconLeft}
        </span>
      )}
      {input}
      {endAdornment && <span className={styles.endAdornment}>{endAdornment}</span>}
    </span>
  );
});
