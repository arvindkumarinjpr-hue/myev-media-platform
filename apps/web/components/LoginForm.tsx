"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { login } from "../lib/api/auth";
import { friendlyMessage } from "../lib/errors";
import { safeNextPath } from "../lib/safe-redirect";
import { Alert } from "./ui/Alert";
import { Button } from "./ui/Button";
import { FormField } from "./ui/FormField";
import { Input } from "./ui/Input";
import { ArrowRightIcon, EyeIcon, EyeOffIcon, LockIcon, MailIcon } from "./ui/icons";
import styles from "./LoginForm.module.css";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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
    <form onSubmit={handleSubmit} className={styles.card} aria-label="Sign in" noValidate>
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
            iconLeft={<MailIcon />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </FormField>

      <FormField
        label="Password"
        labelAction={
          <Link href="/forgot-password" className={styles.forgotLink}>
            Forgot password?
          </Link>
        }
      >
        {(field) => (
          <Input
            {...field}
            type={showPassword ? "text" : "password"}
            required
            autoComplete="current-password"
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </FormField>

      <Button type="submit" fullWidth loading={pending} iconRight={<ArrowRightIcon />} className={styles.submit}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
