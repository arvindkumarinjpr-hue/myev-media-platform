import type { ComponentType, SVGProps } from "react";
import {
  KnowledgePackIcon,
  OverviewIcon,
  ProjectIcon,
  ResearchIcon,
  TopicClusterIcon,
} from "../ui/icons";

export interface NavItem {
  label: string;
  /** Path segment appended to /workspaces/:workspaceId. Empty string = the Overview root. */
  segment: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Workspace permission required to see this item — omit if always visible. */
  permission?: string;
}

export interface NavSection {
  /** Section heading — null for the top-level ungrouped items. */
  title: string | null;
  items: NavItem[];
}

/**
 * Primary navigation IA. Grouped so it scales as later modules land
 * (Content, Publishing, Growth sections slot in without reshuffling what
 * exists). Only routes that actually exist today are listed — Content
 * Series has an API client but no page, so it is intentionally absent.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [{ label: "Overview", segment: "", icon: OverviewIcon }],
  },
  {
    title: "Intelligence",
    items: [
      { label: "Research", segment: "research", icon: ResearchIcon, permission: "RESEARCH_VIEW" },
      { label: "Topic Clusters", segment: "topic-clusters", icon: TopicClusterIcon },
    ],
  },
  {
    title: "Content Foundation",
    items: [
      { label: "Knowledge Packs", segment: "knowledge-packs", icon: KnowledgePackIcon, permission: "KP_VIEW" },
      { label: "Projects", segment: "projects", icon: ProjectIcon, permission: "PROJECT_VIEW" },
    ],
  },
];

export function hrefFor(workspaceId: string, segment: string): string {
  return segment ? `/workspaces/${workspaceId}/${segment}` : `/workspaces/${workspaceId}`;
}

/**
 * Which nav item owns the current pathname. The Overview root only matches
 * exactly; every other item matches its segment prefix so detail routes
 * keep their parent highlighted.
 */
export function isActive(pathname: string, workspaceId: string, segment: string): boolean {
  const base = `/workspaces/${workspaceId}`;
  if (!segment) return pathname === base || pathname === `${base}/`;
  return pathname === `${base}/${segment}` || pathname.startsWith(`${base}/${segment}/`);
}
