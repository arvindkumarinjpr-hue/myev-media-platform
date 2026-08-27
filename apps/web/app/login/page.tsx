import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "../../components/LoginForm";
import { Logo } from "../../components/shell/Logo";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <section className={styles.brandPanel} aria-hidden="true">
        <div className={styles.brandInner}>
          <Logo />
          <p className={styles.brandTagline}>The AI content operating system for EV media teams.</p>
          <ul className={styles.brandPoints}>
            <li>Run grounded research against your own trusted sources.</li>
            <li>Turn findings into planned topic clusters and content series.</li>
            <li>Keep brand, SEO, and knowledge rules in one versioned pack.</li>
          </ul>
        </div>
      </section>

      <section className={styles.formPanel}>
        <div className={styles.formWrap}>
          <span className={styles.mobileBrand}>
            <Logo size="sm" />
          </span>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
