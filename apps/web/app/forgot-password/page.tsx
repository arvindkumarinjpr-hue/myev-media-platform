import { Suspense } from "react";
import type { Metadata } from "next";
import { ForgotPasswordForm } from "../../components/ForgotPasswordForm";
import { LoginBrandPanel } from "../../components/login/LoginBrandPanel";
import styles from "../auth-shell.module.css";

export const metadata: Metadata = {
  title: "Forgot password",
};

export default function ForgotPasswordPage() {
  return (
    <main className={styles.page}>
      <LoginBrandPanel />

      <section className={styles.formPanel}>
        <div className={styles.formWrap}>
          <Suspense fallback={null}>
            <ForgotPasswordForm />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
