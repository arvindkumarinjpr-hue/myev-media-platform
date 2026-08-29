import { Suspense } from "react";
import type { Metadata } from "next";
import { PasswordResetForm } from "../../components/PasswordResetForm";
import { LoginBrandPanel } from "../../components/login/LoginBrandPanel";
import styles from "../auth-shell.module.css";

export const metadata: Metadata = {
  title: "Reset password",
};

export default function ResetPasswordPage() {
  return (
    <main className={styles.page}>
      <LoginBrandPanel />

      <section className={styles.formPanel}>
        <div className={styles.formWrap}>
          <Suspense fallback={null}>
            <PasswordResetForm mode="reset" />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
