import type { ComponentType, SVGProps } from "react";
import {
  BlogIcon,
  KnowledgePackIcon,
  LinkGraphIcon,
  OverviewIcon,
  ProjectIcon,
  PublishingIcon,
  ResearchIcon,
  TopicClusterIcon,
  VideoIcon,
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
      // Module 8 Phase 8.6 — workspace-level orphan/cluster/link-health
      // intelligence (Phase 8.5's read views). BLOG_VIEW, not a new
      // permission: every endpoint behind this page is a BLOG_VIEW read
      // (Part P). The per-article recommendation UI lives on the Blog
      // detail page itself, not here — see BlogPipelineDetail's Internal
      // linking panel.
      { label: "Internal Linking", segment: "internal-linking", icon: LinkGraphIcon, permission: "BLOG_VIEW" },
    ],
  },
  {
    title: "Content",
    items: [
      // Module 6 Phase 6.4 — visible to any role holding BLOG_VIEW
      // (Content Writer, SEO Specialist, Content Manager, Publisher,
      // Administrator, Owner). The backend re-checks BLOG_VIEW on every
      // Blog route regardless of what this hides.
      { label: "Blog", segment: "blog", icon: BlogIcon, permission: "BLOG_VIEW" },
      // Module 7 Phase 7.6 — visible to any role holding VIDEO_VIEW
      // (Content Manager, SEO Specialist, Video Editor, Publisher,
      // Administrator, Owner). The backend re-checks VIDEO_VIEW on every
      // Video route regardless of what this hides.
      { label: "Video", segment: "video", icon: VideoIcon, permission: "VIDEO_VIEW" },
    ],
  },
  {
    title: "Content Foundation",
    items: [
      { label: "Knowledge Packs", segment: "knowledge-packs", icon: KnowledgePackIcon, permission: "KP_VIEW" },
      { label: "Projects", segment: "projects", icon: ProjectIcon, permission: "PROJECT_VIEW" },
    ],
  },
  {
    title: "Publishing",
    items: [
      // Module 9 Phase 9.7 — PUBLISH_CREATE (not PUBLISH_CHANNEL_MANAGE):
      // every role that can create a publication needs to see this page;
      // account management itself is further gated inside the page by
      // PUBLISH_CHANNEL_MANAGE (see PublishingAccountsController's own
      // doc comment for why "view" and "manage" are deliberately split).
      { label: "Publishing", segment: "publishing", icon: PublishingIcon, permission: "PUBLISH_CREATE" },
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
