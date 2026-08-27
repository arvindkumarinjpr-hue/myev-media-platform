"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { logout } from "../lib/api/auth";
import { Button } from "./ui/Button";
import { LogoutIcon } from "./ui/icons";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      iconLeft={<LogoutIcon />}
      onClick={async () => {
        if (pending) return;
        setPending(true);
        await logout();
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
