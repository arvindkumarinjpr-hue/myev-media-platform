/**
 * Lightweight, self-contained decorative graphic — abstract orbiting
 * nodes rendered as inline SVG with the brand blue → violet accent
 * gradient. No external illustration asset or dependency; purely CSS
 * custom properties + SVG, so it inherits whichever palette scope
 * (light workspace, dark sidebar/login panel) it's rendered inside.
 */
export function OrbitArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 320" className={className} focusable="false" aria-hidden="true">
      <defs>
        <linearGradient id="orbit-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-blue)" />
          <stop offset="100%" stopColor="var(--color-accent-violet)" />
        </linearGradient>
      </defs>
      <circle cx="160" cy="160" r="130" fill="none" stroke="url(#orbit-grad)" strokeOpacity="0.18" strokeWidth="1.5" />
      <circle cx="160" cy="160" r="92" fill="none" stroke="url(#orbit-grad)" strokeOpacity="0.28" strokeWidth="1.5" />
      <circle cx="160" cy="160" r="54" fill="none" stroke="url(#orbit-grad)" strokeOpacity="0.4" strokeWidth="1.5" />
      <circle cx="160" cy="160" r="14" fill="url(#orbit-grad)" fillOpacity="0.9" />
      <circle cx="272" cy="120" r="7" fill="url(#orbit-grad)" />
      <circle cx="70" cy="222" r="5" fill="var(--color-accent-violet)" fillOpacity="0.85" />
      <circle cx="228" cy="252" r="4" fill="var(--color-accent-blue)" fillOpacity="0.85" />
      <circle cx="52" cy="96" r="4" fill="url(#orbit-grad)" fillOpacity="0.7" />
    </svg>
  );
}
