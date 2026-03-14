import type { Metadata } from "next";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";

export const metadata: Metadata = {
  title: "Pump Cashback Checker",
  description: "Check and claim unclaimed Pump cashback rewards",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
