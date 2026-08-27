import type { Metadata } from "next";
import { Button } from "../components/ui/Button";
import { Logo } from "../components/shell/Logo";
import styles from "./not-found.module.css";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <Logo size="sm" />
        <div>
          <p className={styles.code}>404</p>
          <h1 className={styles.title}>Page not found</h1>
          <p className={styles.text}>The page you&apos;re looking for doesn&apos;t exist or may have moved.</p>
        </div>
        <Button href="/workspaces">Go to your workspaces</Button>
      </div>
    </main>
  );
}
