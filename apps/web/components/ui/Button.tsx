import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  children: ReactNode;
}

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    href?: undefined;
    loading?: boolean;
  };

type ButtonAsLink = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> & {
    href: string;
  };

export type ButtonProps = ButtonAsButton | ButtonAsLink;

function classes(variant: ButtonVariant, size: ButtonSize, fullWidth: boolean) {
  return cx(styles.button, styles[variant], styles[size], fullWidth && styles.fullWidth);
}

/**
 * The one button in the app. Renders a real <button> by default, or a
 * Next <Link> when `href` is set (so "New Research" links and submit
 * buttons share one visual language). `loading` (button form only) shows a
 * spinner and disables interaction without changing layout width.
 */
export function Button(props: ButtonProps) {
  const { variant = "primary", size = "md", fullWidth = false, iconLeft, iconRight, children } = props;

  if (props.href !== undefined) {
    const { href, className, variant: _v, size: _s, fullWidth: _f, iconLeft: _il, iconRight: _ir, children: _c, ...rest } =
      props;
    return (
      <Link href={href} className={cx(classes(variant, size, fullWidth), className)} {...rest}>
        {iconLeft && <span className={styles.icon}>{iconLeft}</span>}
        <span>{children}</span>
        {iconRight && <span className={styles.icon}>{iconRight}</span>}
      </Link>
    );
  }

  const {
    className,
    loading = false,
    disabled,
    type = "button",
    variant: _v,
    size: _s,
    fullWidth: _f,
    iconLeft: _il,
    iconRight: _ir,
    children: _c,
    ...rest
  } = props;

  return (
    <button
      type={type}
      className={cx(classes(variant, size, fullWidth), loading && styles.loading, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      {!loading && iconLeft && <span className={styles.icon}>{iconLeft}</span>}
      <span>{children}</span>
      {!loading && iconRight && <span className={styles.icon}>{iconRight}</span>}
    </button>
  );
}
