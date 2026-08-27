"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login } from "../lib/api/auth";
import { friendlyMessage } from "../lib/errors";
import { safeNextPath } from "../lib/safe-redirect";
import { Alert } from "./ui/Alert";
import { Button } from "./ui/Button";
import { FormField } from "./ui/FormField";
import { Input } from "./ui/Input";
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
      router.push(safeNextPath(searchParams.get("next")));
      router.refresh();
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label="Sign in" noValidate>
      <div className={styles.formHead}>
        <h1 className={styles.heading}>Sign in</h1>
        <p className={styles.subtext}>Welcome back. Enter your details to access your workspaces.</p>
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
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </FormField>

      <FormField label="Password">
        {(field) => (
          <Input
            {...field}
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </FormField>

      <Button type="submit" fullWidth loading={pending} className={styles.submit}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
