"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { resetPassword } from "../lib/api/auth";
import { ApiError, friendlyMessage } from "../lib/errors";
import { Alert } from "./ui/Alert";
import { Button } from "./ui/Button";
import { FormField } from "./ui/FormField";
import { Input } from "./ui/Input";
import { CheckCircleIcon, EyeIcon, EyeOffIcon, LockIcon, XCircleIcon } from "./ui/icons";
import styles from "./AuthForm.module.css";

const MIN_PASSWORD_LENGTH = 12;
// Both codes mean "this specific link no longer works" — the backend's
// own message text (already safe/specific: "Link is invalid.", "Link has
// already been used.", "Link has expired.") is what actually
// distinguishes them; the UI only needs to know they share one recovery
// state.
const LINK_INVALID_CODES = new Set(["AUTH_RESET_TOKEN_INVALID", "AUTH_RESET_TOKEN_EXPIRED"]);

interface PasswordResetFormProps {
  mode: "reset" | "activate";
}

const COPY = {
  reset: {
    heading: "Reset your password",
    subtext: "Choose a new password for your account.",
    submitLabel: "Reset password",
    submitLabelPending: "Resetting…",
    successHeading: "Password updated",
    successBody: "Your password has been reset. You can now sign in with your new password.",
    linkInvalidHeading: "Link invalid or expired",
    linkInvalidFallback: "This password reset link is invalid or has expired.",
  },
  activate: {
    heading: "Activate your account",
    subtext: "Set a password to activate your account.",
    submitLabel: "Activate account",
    submitLabelPending: "Activating…",
    successHeading: "Account activated",
    successBody: "Your account is now active. You can sign in with your new password.",
    linkInvalidHeading: "Link invalid or expired",
    linkInvalidFallback: "This activation link is invalid or has expired.",
  },
} as const;

export function PasswordResetForm({ mode }: PasswordResetFormProps) {
  const copy = COPY[mode];
  const token = useSearchParams().get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // null = link is fine (or not yet checked); a string = the reason it
  // isn't, shown in the terminal "link invalid" state below.
  const [linkInvalidReason, setLinkInvalidReason] = useState<string | null>(token ? null : copy.linkInvalidFallback);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending || !token) return;
    if (newPassword !== confirmPassword || newPassword.length < MIN_PASSWORD_LENGTH) return;

    setPending(true);
    setError(null);
    try {
      await resetPassword(token, newPassword);
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError && LINK_INVALID_CODES.has(err.code)) {
        setLinkInvalidReason(err.message || copy.linkInvalidFallback);
      } else {
        setError(friendlyMessage(err));
      }
    } finally {
      setPending(false);
    }
  }

  if (success) {
    return (
      <div className={styles.card}>
        <span className={`${styles.stateIcon} ${styles.stateIconSuccess}`} aria-hidden="true">
          <CheckCircleIcon />
        </span>
        <div className={styles.formHead}>
          <h1 className={styles.heading}>{copy.successHeading}</h1>
          <p className={styles.subtext}>{copy.successBody}</p>
        </div>
        <Button href="/login" fullWidth>
          Go to sign in
        </Button>
      </div>
    );
  }

  if (linkInvalidReason) {
    return (
      <div className={styles.card}>
        <span className={`${styles.stateIcon} ${styles.stateIconInvalid}`} aria-hidden="true">
          <XCircleIcon />
        </span>
        <div className={styles.formHead}>
          <h1 className={styles.heading}>{copy.linkInvalidHeading}</h1>
          <p className={styles.subtext}>{linkInvalidReason}</p>
        </div>
        {mode === "reset" ? (
          <Button href="/forgot-password" fullWidth>
            Request a new link
          </Button>
        ) : (
          <p className={styles.subtext}>Please contact your workspace administrator for a new invitation link.</p>
        )}
        <Link href="/login" className={styles.backLink}>
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={styles.card} aria-label={copy.heading} noValidate>
      <div className={styles.formHead}>
        <h1 className={styles.heading}>{copy.heading}</h1>
        <p className={styles.subtext}>{copy.subtext}</p>
      </div>

      {error && (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      )}

      <FormField label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={tooShort ? `Must be at least ${MIN_PASSWORD_LENGTH} characters.` : undefined}>
        {(field) => (
          <Input
            {...field}
            type={showPassword ? "text" : "password"}
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            iconLeft={<LockIcon />}
            endAdornment={
              <button
                type="button"
                className={styles.toggleVisibility}
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            }
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        )}
      </FormField>

      <FormField label="Confirm password" error={mismatch ? "Passwords don't match." : undefined}>
        {(field) => (
          <Input
            {...field}
            type={showPassword ? "text" : "password"}
            required
            autoComplete="new-password"
            iconLeft={<LockIcon />}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        )}
      </FormField>

      <Button
        type="submit"
        fullWidth
        loading={pending}
        disabled={!newPassword || !confirmPassword || mismatch || tooShort}
        className={styles.submit}
      >
        {pending ? copy.submitLabelPending : copy.submitLabel}
      </Button>

      <Link href="/login" className={styles.backLink}>
        Back to sign in
      </Link>
    </form>
  );
}
