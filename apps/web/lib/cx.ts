/** Minimal class-name joiner — falsy values are dropped. Avoids a dependency for the one thing `clsx` is used for. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}
