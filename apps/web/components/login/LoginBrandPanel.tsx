import type { ComponentType, SVGProps } from "react";
import { Logo } from "../shell/Logo";
import { ResearchIcon, TopicClusterIcon, KnowledgePackIcon, SparkleIcon } from "../ui/icons";
import { AiOrbitVisual } from "./AiOrbitVisual";
import styles from "./LoginBrandPanel.module.css";

interface Feature {
  title: string;
  description: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const FEATURES: Feature[] = [
  {
    title: "Grounded Research",
    description: "Run in-depth research using your trusted sources.",
    icon: ResearchIcon,
  },
  {
    title: "Smart Planning",
    description: "Turn findings into structured topic clusters and content series.",
    icon: TopicClusterIcon,
  },
  {
    title: "Unified Knowledge",
    description: "Keep brand, SEO, and knowledge rules in one versioned pack.",
    icon: KnowledgePackIcon,
  },
];

/**
 * The premium dark left panel on /login — the ONE place the MYEV Media
 * logo appears on this page (see LoginPage). Purely presentational.
 */
export function LoginBrandPanel() {
  return (
    <section className={styles.panel} aria-hidden="true">
      {/* Defines the flowing right-edge curve applied via CSS clip-path
       * on .panel (objectBoundingBox units — 0..1 fractions of the
       * panel's own box, so the curve scales correctly at any size). No
       * visible pixels of its own. */}
      <svg width="0" height="0" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id="login-brand-curve" clipPathUnits="objectBoundingBox">
            <path d="M0,0 H0.94 C0.80,0.18 0.98,0.36 0.88,0.5 C0.98,0.64 0.80,0.82 0.94,1 H0 Z" />
          </clipPath>
        </defs>
      </svg>
      <div className={styles.glowTop} />
      <div className={styles.glowBottom} />

      <div className={styles.inner}>
        {/* The "EV" wordmark in the master artwork is dark navy — needs a
         * light backing to read on this dark panel. A small, tightly
         * cropped chip (not an oversized rectangle) is the minimal
         * background treatment the logo lock never redraws/recolours. */}
        <span className={styles.logoChip}>
          <Logo size="sm" />
        </span>

        <div className={styles.copy}>
          <h1 className={styles.headline}>
            The AI content
            <br />
            <span className={styles.headlineAccent}>operating system</span>
            <br />
            for EV media teams.
          </h1>
          <p className={styles.tagline}>
            Research deeply. Plan intelligently.
            <br />
            Create consistently. Grow exponentially.
          </p>
        </div>

        <AiOrbitVisual className={styles.orbit} />

        <ul className={styles.features}>
          {FEATURES.map((f) => (
            <FeatureRow key={f.title} feature={f} />
          ))}
        </ul>

        <Callout />
      </div>
    </section>
  );
}

function FeatureRow({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <li className={styles.feature}>
      <span className={styles.featureIcon}>
        <Icon />
      </span>
      <span className={styles.featureText}>
        <span className={styles.featureTitle}>{feature.title}</span>
        <span className={styles.featureDescription}>{feature.description}</span>
      </span>
    </li>
  );
}

function Callout() {
  return (
    <div className={styles.callout}>
      <span className={styles.calloutIcon}>
        <SparkleIcon />
      </span>
      <div className={styles.calloutText}>
        <p className={styles.calloutTitle}>AI-Powered Content OS</p>
        <p className={styles.calloutBody}>
          Intelligent. Automated. Impactful.
          <br />
          <span className={styles.calloutAccent}>Built for EV media teams.</span>
        </p>
      </div>
    </div>
  );
}
