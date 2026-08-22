"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login } from "../lib/api/auth";
import { friendlyMessage } from "../lib/errors";
import { ErrorBanner } from "./ui/Feedback";
import styles from "../app/login/page.module.css";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await login(email, password);
      const next = searchParams.get("next") ?? "/workspaces";
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label="Sign in">
      <h1 className={styles.heading}>MYEV Media</h1>
      {error && <ErrorBanner message={error} />}
      <label htmlFor="email" className={styles.label}>
        Email
      </label>
      <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={styles.input} autoComplete="email" />
      <label htmlFor="password" className={styles.label}>
        Password
      </label>
      <input
        id="password"
        type="password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className={styles.input}
        autoComplete="current-password"
      />
      <button type="submit" disabled={pending} className={styles.submitButton}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
