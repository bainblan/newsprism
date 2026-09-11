/**
 * Masthead and footer. Server components — nothing here depends on fetched
 * data, so the shell paints immediately while the stories are still in flight.
 */

import Link from "next/link";

import { API_BASE_URL, USE_MOCK_DATA } from "@/lib/config";

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-6 sm:px-8 sm:py-8">
        <Link href="/" className="font-serif text-2xl font-semibold tracking-tight">
          newsprism
        </Link>
        <p className="text-sm text-subtle">
          The same story, split by where it is reported from.
        </p>
        {USE_MOCK_DATA ? (
          <span className="ml-auto rounded-sm border border-border-strong px-2 py-0.5 font-mono text-[0.6875rem] text-muted">
            mock data
          </span>
        ) : null}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto w-full max-w-5xl space-y-2 px-5 py-8 sm:px-8">
        <p className="max-w-[62ch] text-xs leading-5 text-subtle">
          Lean labels describe the outlet, not the individual article, and they
          are an editorial judgement rather than a measurement. They approximate
          widely published media-bias assessments and are meant to be argued
          with.
        </p>
        <p className="font-mono text-[0.6875rem] text-subtle">
          API {API_BASE_URL}
        </p>
      </div>
    </footer>
  );
}
