import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "MYEV Media",
    template: "%s · MYEV Media",
  },
  description: "AI content operating system for EV media teams — research, planning, and knowledge in one workspace.",
  applicationName: "MYEV Media",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
