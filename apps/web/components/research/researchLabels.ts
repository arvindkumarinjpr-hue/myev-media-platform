import type { BadgeTone } from "../ui/Badge";
import type { ResearchStatus, TrendSignal } from "../../lib/types";

export const RESEARCH_STATUS: Record<ResearchStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  QUEUED: { label: "Queued", tone: "neutral", dot: true },
  RUNNING: { label: "Running", tone: "warning", dot: true },
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  TIMED_OUT: { label: "Timed out", tone: "danger" },
};

export const TREND_DIRECTION: Record<TrendSignal["direction"], { label: string; tone: BadgeTone }> = {
  rising: { label: "Rising", tone: "success" },
  steady: { label: "Steady", tone: "neutral" },
  declining: { label: "Declining", tone: "danger" },
};

export const TREND_FRESHNESS: Record<TrendSignal["freshness"], string> = {
  new: "New",
  ongoing: "Ongoing",
  "long-standing": "Long-standing",
};

/**
 * User-facing copy for a failed run. `errorMessageSafe` from the backend
 * is already curated, but a few known codes deserve clearer wording;
 * everything else falls back to the safe message, then to a generic line.
 * Never surfaces stack traces, provider registry internals, or raw
 * processor errors — those never reach `errorMessageSafe` anyway.
 */
export function failureExplanation(errorCode: string | null, errorMessageSafe: string | null): string {
  switch (errorCode) {
    case "PROVIDER_NOT_CONFIGURED":
      return "The AI provider required for this Research run isn't configured for this workspace yet. Ask an administrator to connect one, then start a new run.";
    case "TIMED_OUT":
      return "This Research run took too long and was stopped. Try again — a narrower topic often completes faster.";
    default:
      return errorMessageSafe?.trim() || "This Research run didn't complete successfully. You can start a new one.";
  }
}
