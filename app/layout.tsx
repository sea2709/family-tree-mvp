import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Family Tree — built by talking",
  description:
    "Build a family tree mostly through chat conversation. Proposals are confirmed before they enter the tree.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
