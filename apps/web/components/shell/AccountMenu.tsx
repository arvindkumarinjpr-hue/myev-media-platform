"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "../../lib/api/auth";
import { ChevronDownIcon, LogoutIcon } from "../ui/icons";
import { Menu } from "./Menu";
import styles from "./AccountMenu.module.css";

/**
 * Account control. The platform exposes no user profile endpoint (no
 * name/email on /auth/me), so this identifies the signed-in session by
 * workspace role and provides the sign-out action.
 */
export function AccountMenu({ role }: { role?: string }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <Menu
      label="Account"
      align="end"
      side="up"
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" className={styles.trigger} {...props}>
          <span className={styles.avatar} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5" strokeLinecap="round" />
            </svg>
          </span>
          <span className={styles.label}>Account</span>
          <ChevronDownIcon className={styles.chevron} />
        </button>
      )}
    >
      {role && <p className="menu-label">Signed in · {role}</p>}
      <button type="button" role="menuitem" className="menu-item" onClick={handleSignOut} disabled={signingOut}>
        <LogoutIcon />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </Menu>
  );
}
