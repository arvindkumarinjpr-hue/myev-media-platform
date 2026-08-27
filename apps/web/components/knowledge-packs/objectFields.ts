/**
 * Helpers for editing a few known keys of a schema-less JSON object while
 * leaving every other key untouched. Structured fields call `setStr` /
 * `setList` which return a NEW object with only that one key changed (or
 * removed when cleared) — so unknown keys are always carried through.
 */

export function readStr(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

export function readList(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function setStr(obj: Record<string, unknown>, key: string, value: string): Record<string, unknown> {
  const next = { ...obj };
  if (value.trim() === "") delete next[key];
  else next[key] = value;
  return next;
}

export function setList(obj: Record<string, unknown>, key: string, value: string[]): Record<string, unknown> {
  const next = { ...obj };
  if (value.length === 0) delete next[key];
  else next[key] = value;
  return next;
}
