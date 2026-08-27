import { cx } from "../../lib/cx";
import styles from "./Logo.module.css";

/**
 * The official MYEV Media logo — the horizontal lockup, rendered from the
 * raster assets derived (without any redrawing/recolouring) from the
 * master SVG. Intrinsic aspect ratio 2892:1378 ≈ 2.10:1; callers size it
 * via the `size` prop and the artwork scales uniformly.
 */
export function Logo({ size = "md", className }: { size?: "sm" | "md"; className?: string }) {
  return (
    <picture>
      <source srcSet="/brand/ev-media-logo.webp" type="image/webp" />
      <img
        src="/brand/ev-media-logo.png"
        alt="MYEV Media"
        width={2892}
        height={1378}
        decoding="async"
        className={cx(styles.logo, styles[size], className)}
      />
    </picture>
  );
}
