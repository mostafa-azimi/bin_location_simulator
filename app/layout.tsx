import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bin Route Simulator",
  description: "A ShipHero bin location route simulator for WMS onboarding.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
