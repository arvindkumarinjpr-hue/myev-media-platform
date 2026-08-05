import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MYEV Media",
  description: "AI-powered EV content operating platform — Module 1A scaffold.",
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
