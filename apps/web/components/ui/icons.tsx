import type { SVGProps } from "react";

/**
 * Small stroke-icon set (24×24 viewBox, 1.6 stroke, currentColor). Icons
 * are decorative by default (aria-hidden) — when an icon is the only label
 * for a control, the control itself must carry an aria-label.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </Base>
  );
}

export function ResearchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Base>
  );
}

export function TopicClusterIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="17" r="2.5" />
      <circle cx="19" cy="17" r="2.5" />
      <path d="M10.4 7 6.5 14.6M13.6 7l3.9 7.6M7.5 17h9" />
    </Base>
  );
}

export function KnowledgePackIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5Z" />
      <path d="M5 16.5A1.5 1.5 0 0 1 6.5 15H19" />
      <path d="M9 7h6" />
    </Base>
  );
}

export function ProjectIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Base>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Base>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Base>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m6 9 6 6 6-6" />
    </Base>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m9 6 6 6-6 6" />
    </Base>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="m5 12.5 4.5 4.5L19 6.5" />
    </Base>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
      <path d="M10 8 6 12l4 4M6 12h12" />
    </Base>
  );
}

export function SwitchIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </Base>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3 2.5 20h19Z" />
      <path d="M12 10v4.5M12 17.5h.01" />
    </Base>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Base>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M14 4h6v6M20 4l-8.5 8.5" />
      <path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5" />
    </Base>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </Base>
  );
}

export function TrendUpIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 17 10 10l4 4 7-7" />
      <path d="M14 7h7v7" />
    </Base>
  );
}

export function TrendFlatIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 12h16" />
      <path d="m17 8 4 4-4 4" />
    </Base>
  );
}

export function TrendDownIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 7 10 14l4-4 7 7" />
      <path d="M14 17h7v-7" />
    </Base>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </Base>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Base>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </Base>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3.5 3.5 20.5 20.5" />
      <path d="M9.9 5.7A10.6 10.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.3 15.3 0 0 1-3.1 3.9M6.2 7.6C4 9.2 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.8 9.8 0 0 0 3.4-.6" />
      <path d="M9.9 10a2.75 2.75 0 0 0 3.9 3.9" />
    </Base>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </Base>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
      <circle cx="12" cy="12" r="3" />
    </Base>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6.5 3h8L19 7.5V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 7 19V4.5A1.5 1.5 0 0 1 6.5 3Z" />
      <path d="M14 3v4.5H19M9.5 12h5M9.5 15.5h5" />
    </Base>
  );
}


export function BlogIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9.8a1.5 1.5 0 0 1 1.06.44l2.2 2.2A1.5 1.5 0 0 1 20 7.7V18.5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5Z" />
      <path d="M8 9.5h5M8 13h8M8 16.5h8" />
    </Base>
  );
}

export function VideoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="6" width="12" height="12" rx="1.5" />
      <path d="m15 10 5-2.5v9L15 14" />
    </Base>
  );
}

export function LinkGraphIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h4a3 3 0 0 1 3 3v4" />
    </Base>
  );
}

export function CheckCircleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5L16 9" />
    </Base>
  );
}

export function XCircleIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </Base>
  );
}

export function PublishingIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M21 3 3 10.5l7.5 3L14 21l7-18Z" />
      <path d="M10.5 13.5 21 3" />
    </Base>
  );
}
