import type { Metadata } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { StoriesProvider } from "@/components/StoriesProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/** Headline face. Newsreader is a text serif designed for on-screen news. */
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "newsprism",
  description:
    "The same story, split by where it is reported from. Headlines from across the political spectrum, clustered by event and shown with their coverage spread.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/* One provider for the whole app: the list response also feeds the
            detail route, so navigating between them never refetches. */}
        <StoriesProvider>
          <SiteHeader />
          <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8 sm:px-8 sm:py-10">
            {children}
          </main>
          <SiteFooter />
        </StoriesProvider>
      </body>
    </html>
  );
}
