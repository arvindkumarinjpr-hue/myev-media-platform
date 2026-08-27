import { cx } from "../../lib/cx";
import { ResearchIcon, KnowledgePackIcon, ProjectIcon, TopicClusterIcon, DocumentIcon } from "../ui/icons";
import styles from "./AiOrbitVisual.module.css";

interface OrbitNode {
  label: string;
  icon: typeof ResearchIcon;
  /** Degrees around the ring — purely a static layout choice, not tied to
   * any external reference frame. */
  angle: number;
}

// Percentage-of-stage radius for each ring — matches the SVG orbit paths'
// own rx/ry (108/400 and 172/400 of the 400×400 viewBox), so the HTML
// nodes and the SVG rings stay visually aligned at any responsive size.
const INNER_RADIUS_PCT = 27;
const OUTER_RADIUS_PCT = 43;

const INNER: OrbitNode[] = [
  { label: "Research", icon: ResearchIcon, angle: 20 },
  { label: "Knowledge", icon: KnowledgePackIcon, angle: 200 },
];

const OUTER: OrbitNode[] = [
  { label: "Intelligence", icon: TopicClusterIcon, angle: -10 },
  { label: "Content", icon: DocumentIcon, angle: 110 },
  { label: "Projects", icon: ProjectIcon, angle: 230 },
];

/**
 * Original, lightweight AI-platform illustration — a centre "AI" core
 * with two orbital rings of icon nodes. Pure SVG (orbit paths) + CSS
 * transforms (node placement/rotation) — no image asset, no canvas/WebGL.
 *
 * Each node is positioned with plain left/top percentages (relative to
 * the stage, so it scales correctly at any responsive size — a
 * translateX() radius would instead be relative to the node's own tiny
 * width, which doesn't scale with the container). The ring wrapping each
 * node set is what animates (a clean 0→360deg sweep); each node's own
 * icon tile carries an equal-and-opposite counter-rotation of the same
 * duration, so it stays upright while still travelling around the ring.
 *
 * Motion is CSS-only and fully covered by the app-wide
 * prefers-reduced-motion rule in globals.css (which forces every
 * animation duration to ~0, freezing this on a valid, complete-looking
 * single frame — the same pattern OrbitArt already uses).
 */
export function AiOrbitVisual({ className }: { className?: string }) {
  return (
    <div className={cx(styles.stage, className)} aria-hidden="true">
      <svg viewBox="0 0 400 400" className={styles.paths} focusable="false">
        <defs>
          <linearGradient id="orbit-path-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-cyan)" />
            <stop offset="55%" stopColor="var(--color-accent-blue)" />
            <stop offset="100%" stopColor="var(--color-accent-violet)" />
          </linearGradient>
        </defs>
        <ellipse cx="200" cy="200" rx="108" ry="108" className={styles.pathInner} />
        <ellipse cx="200" cy="200" rx="172" ry="172" className={styles.pathOuter} />
      </svg>

      <div className={cx(styles.ring, styles.ringInner)}>
        {INNER.map((n) => (
          <Node key={n.label} node={n} radiusPct={INNER_RADIUS_PCT} spinClass={styles.counterInner} />
        ))}
      </div>

      <div className={cx(styles.ring, styles.ringOuter)}>
        {OUTER.map((n) => (
          <Node key={n.label} node={n} radiusPct={OUTER_RADIUS_PCT} spinClass={styles.counterOuter} />
        ))}
      </div>

      <div className={styles.core}>
        <span className={styles.coreLabel}>AI</span>
      </div>
    </div>
  );
}

function Node({ node, radiusPct, spinClass }: { node: OrbitNode; radiusPct: number; spinClass: string }) {
  const Icon = node.icon;
  const rad = (node.angle * Math.PI) / 180;
  const left = 50 + radiusPct * Math.cos(rad);
  const top = 50 + radiusPct * Math.sin(rad);

  return (
    <div className={styles.node} style={{ left: `${left}%`, top: `${top}%` }}>
      <div className={cx(styles.nodeInner, spinClass)}>
        <span className={styles.nodeIcon}>
          <Icon />
        </span>
      </div>
    </div>
  );
}
