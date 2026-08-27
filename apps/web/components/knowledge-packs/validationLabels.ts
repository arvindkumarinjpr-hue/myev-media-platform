import { contentTypeLabel } from "./labels";

/**
 * Turns a raw backend activation-gate failure string into a readable
 * requirement. The raw string is always kept and shown too — business
 * logic lives in the backend, this only makes its output legible and
 * never invents a rule the backend didn't report.
 */
export interface ReadableFailure {
  title: string;
  help?: string;
  raw: string;
  isRestrict: boolean;
}

export function toReadableFailure(raw: string): ReadableFailure {
  const restrict = /RESTRICT/i.test(raw);

  if (/FR-KP-002/.test(raw) || /trusted knowledge source/i.test(raw)) {
    return { title: "Add at least one trusted source", help: "Your agents need a source they can cite.", raw, isRestrict: restrict };
  }
  if (/FR-KP-003/.test(raw) || /prompt template/i.test(raw)) {
    const missing = raw.match(/missing:\s*([^.(]+)/i)?.[1]?.trim();
    const friendly = missing
      ? missing
          .split(",")
          .map((t) => contentTypeLabel(t.trim()))
          .join(", ")
      : undefined;
    return {
      title: "Add a prompt template for every content type",
      help: friendly ? `Still missing: ${friendly}.` : "One template is required per content type.",
      raw,
      isRestrict: restrict,
    };
  }
  if (/FR-KP-001/.test(raw) || /industry profile/i.test(raw)) {
    return { title: "Fill in the name and industry profile", help: "Set the pack name and at least one industry-profile field on the Overview tab.", raw, isRestrict: restrict };
  }
  if (/FR-KP-004/.test(raw) || /publishing strategy/i.test(raw)) {
    return { title: "Choose a publishing cadence", help: "Set how often content is published on the Overview tab.", raw, isRestrict: restrict };
  }
  if (restrict) {
    return { title: "Reassign Projects still using the previous version", help: "A Project is pinned to the version this one would replace.", raw, isRestrict: true };
  }
  return { title: raw, raw, isRestrict: restrict };
}
