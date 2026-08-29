"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { forgotPassword } from "../lib/api/auth";
import { friendlyMessage } from "../lib/errors";
import { Alert } from "./ui/Alert";
import { Button } from "./ui/Button";
import { FormField } from "./ui/FormField";
import { Input } from "./ui/Input";
import { CheckCircleIcon, MailIcon } from "./ui/icons";
import styles from "./AuthForm.module.css";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set only on a real 200 from the backend — never assumed, never shown
  // before the request round-trips, so a network/system failure below
  // still surfaces as an error rather than a false "check your email".
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await forgotPassword(email);
      setSentTo(email);
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <div className={styles.card}>
        <span className={`${styles.stateIcon} ${styles.stateIconSuccess}`} aria-hidden="true">
          <CheckCircleIcon />
        </span>
        <div className={styles.formHead}>
          <h1 className={styles.heading}>Check your email</h1>
          <p className={styles.subtext}>
            If an account exists for <strong>{sentTo}</strong>, we&apos;ve sent a link to reset your password. The link expires soon, so
            use it shortly.
          </p>
        </div>
        <Link href="/login" className={styles.backLink}>
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={styles.card} aria-label="Forgot password" noValidate>
      <div className={styles.formHead}>
        <h1 className={styles.heading}>Forgot password?</h1>
        <p className={styles.subtext}>Enter your email and we&apos;ll send you a link to reset your password.</p>
      </div>

      {error && (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      )}

      <FormField label="Email">
        {(field) => (
          <Input
            {...field}
            type="email"
            required
            autoComplete="email"
            autoFocus
            iconLeft={<MailIcon />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </FormField>

      <Button type="submit" fullWidth loading={pending} className={styles.submit}>
        {pending ? "Sending…" : "Send reset link"}
      </Button>

      <Link href="/login" className={styles.backLink}>
        Back to sign in
      </Link>
    </form>
  );
}
