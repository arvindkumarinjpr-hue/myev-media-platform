import { cx } from "../../lib/cx";
import { CheckIcon } from "./icons";
import styles from "./Stepper.module.css";

export interface Step {
  id: string;
  label: string;
}

interface StepperProps {
  steps: Step[];
  /** Index of the current step. */
  current: number;
  /** Allow clicking back to an already-completed step. */
  onStepClick?: (index: number) => void;
  className?: string;
}

export function Stepper({ steps, current, onStepClick, className }: StepperProps) {
  return (
    <ol className={cx(styles.stepper, className)} aria-label="Progress">
      {steps.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "upcoming";
        const clickable = state === "done" && onStepClick;
        return (
          <li key={step.id} className={cx(styles.step, styles[state])} aria-current={state === "current" ? "step" : undefined}>
            {clickable ? (
              <button type="button" className={styles.trigger} onClick={() => onStepClick(i)}>
                <StepMarker state={state} index={i} />
                <span className={styles.label}>{step.label}</span>
              </button>
            ) : (
              <span className={styles.trigger}>
                <StepMarker state={state} index={i} />
                <span className={styles.label}>{step.label}</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepMarker({ state, index }: { state: string; index: number }) {
  return (
    <span className={styles.marker} aria-hidden="true">
      {state === "done" ? <CheckIcon /> : index + 1}
    </span>
  );
}
