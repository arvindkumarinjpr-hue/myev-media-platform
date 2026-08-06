/**
 * Module 1F Engineering Plan §4. The 9 categories from the frozen
 * QUEUE_AND_BACKGROUND_JOB_ENGINE_V1.0.md §3, verbatim — a closed set,
 * never a free string. Structurally identical to the Prisma `QueueName`
 * enum (apps/api/prisma/schema.prisma) — duplicated here deliberately,
 * not imported from the generated Prisma client, since this package must
 * stay usable from the worker process without depending on apps/api's
 * generated output. Low-risk: these 9 values are frozen/closed per the
 * spec, not expected to change independently of a schema migration that
 * would already require touching both places.
 */
export const QUEUE_NAMES = [
  "CRITICAL",
  "REALTIME",
  "AI",
  "MEDIA",
  "PUBLISHING",
  "ANALYTICS",
  "MAINTENANCE",
  "NOTIFICATION",
  "SYSTEM",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: unknown): value is QueueName {
  return typeof value === "string" && (QUEUE_NAMES as readonly string[]).includes(value);
}
