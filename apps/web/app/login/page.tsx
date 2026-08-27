import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "../../components/LoginForm";
import { LoginBrandPanel } from "../../components/login/LoginBrandPanel";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <main className={styles.page}>
      {/* The MYEV Media logo appears exactly once on this page, inside
       * LoginBrandPanel — the form panel never renders its own copy. */}
      <LoginBrandPanel />

      <section className={styles.formPanel}>
        <div className={styles.formWrap}>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
