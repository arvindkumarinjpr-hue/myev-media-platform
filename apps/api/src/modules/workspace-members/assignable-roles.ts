/**
 * Every seeded role except Owner (Module 1C Engineering Plan §2.C: only
 * ownership transfer — never an invitation or a role-change PATCH — may
 * ever move someone into Owner; §2.C also restricts who may grant/move
 * someone into Owner, but the simpler, stronger rule enforced here is that
 * NO invitation or role-change endpoint can name Owner at all).
 */
export const ASSIGNABLE_ROLE_NAMES = [
  "Administrator",
  "Content Manager",
  "Content Writer",
  "SEO Specialist",
  "Video Editor",
  "Publisher",
  "Analyst",
] as const;
