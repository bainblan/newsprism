/* ==========================================================================
 * MOCK DATA — DELETE-ME CANDIDATE
 * ==========================================================================
 *
 * This is the ONLY module in the app containing fabricated API data. Nothing
 * here is imported unless NEXT_PUBLIC_USE_MOCK_DATA === "true", and src/lib/api.ts
 * reaches it through a dynamic import so it is code-split out of a normal build.
 *
 * It exists because the frontend and backend are built in parallel: the backend
 * may not be running (or may not exist) while this UI is developed.
 *
 * WHEN THE REAL BACKEND LANDS:
 *   1. Unset NEXT_PUBLIC_USE_MOCK_DATA (that alone is sufficient — no code change).
 *   2. Once integration is confirmed, delete this file, the USE_MOCK_DATA /
 *      MOCK_SCENARIO entries in src/lib/config.ts, the three `if (USE_MOCK_DATA)`
 *      branches in src/lib/api.ts, and the mock lines in .env.example.
 *
 * Every shape below is hand-checked against docs/api-contract.md. Coverage and
 * article_count are DERIVED from the sources array so the contract invariants
 * (all five lean keys present; sum(coverage) === article_count) cannot drift.
 * ========================================================================== */

import { ApiError } from "../api";
import { MOCK_SCENARIO } from "../config";
import type {
  Coverage,
  IngestResult,
  OutletsResponse,
  SourceArticle,
  StoriesResponse,
  Story,
} from "../types";

/**
 * How long the fake ingest pretends to run. The real one takes 30-60s; this is
 * deliberately shorter so the progress UI can be exercised without the wait.
 */
const MOCK_INGEST_MS = 6_000;
const MOCK_LATENCY_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ISO 8601 UTC with trailing Z, n minutes before now. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

type MockSource = Omit<SourceArticle, "url" | "published_at"> & {
  minutesAgo: number;
};

function buildStory(input: {
  id: string;
  title: string;
  summary: string;
  updatedMinutesAgo: number;
  sources: MockSource[];
}): Story {
  const coverage: Coverage = {
    left: 0,
    lean_left: 0,
    center: 0,
    lean_right: 0,
    right: 0,
  };

  const sources: SourceArticle[] = input.sources.map((source, index) => {
    coverage[source.lean] += 1;
    return {
      outlet: source.outlet,
      lean: source.lean,
      title: source.title,
      url: `https://example.com/${input.id}/${index}`,
      published_at: minutesAgo(source.minutesAgo),
    };
  });

  return {
    id: input.id,
    title: input.title,
    summary: input.summary,
    updated_at: minutesAgo(input.updatedMinutesAgo),
    article_count: sources.length,
    coverage,
    sources,
  };
}

const MOCK_STORIES: Story[] = [
  buildStory({
    id: "c_8f3a1b",
    title:
      "Senate clears procedural hurdle on stopgap funding bill hours before deadline",
    summary:
      "The 62-35 vote sets up a final passage attempt Friday, extending current spending levels into February while negotiators keep working on full-year appropriations.",
    updatedMinutesAgo: 22,
    sources: [
      {
        outlet: "Reuters",
        lean: "center",
        title: "US Senate advances stopgap funding bill, averting weekend shutdown",
        minutesAgo: 28,
      },
      {
        outlet: "Axios",
        lean: "center",
        title: "Senate takes key step toward avoiding a government shutdown",
        minutesAgo: 41,
      },
      {
        outlet: "BBC News",
        lean: "center",
        title: "US Senate moves to avert government shutdown",
        minutesAgo: 55,
      },
      {
        outlet: "NPR",
        lean: "lean_left",
        title: "Senate advances short-term funding bill as deadline nears",
        minutesAgo: 66,
      },
      {
        outlet: "The Guardian (US)",
        lean: "lean_left",
        title: "Senate clears path for stopgap bill after weeks of brinkmanship",
        minutesAgo: 70,
      },
      {
        outlet: "New York Times",
        lean: "lean_left",
        title: "Senate Advances Stopgap Bill, Easing Shutdown Fears for Now",
        minutesAgo: 88,
      },
      {
        outlet: "Washington Post",
        lean: "lean_left",
        title: "Senate vote pushes shutdown fight into February",
        minutesAgo: 95,
      },
      {
        outlet: "HuffPost",
        lean: "left",
        title: "Senate Finally Moves On Funding After Weeks Of Brinkmanship",
        minutesAgo: 102,
      },
      {
        outlet: "New York Post",
        lean: "lean_right",
        title: "Senate punts spending fight to February in 62-35 vote",
        minutesAgo: 44,
      },
      {
        outlet: "Fox News",
        lean: "right",
        title:
          "Senate advances stopgap as conservatives blast another clean extension",
        minutesAgo: 33,
      },
      {
        outlet: "Washington Times",
        lean: "right",
        title: "Senate clears stopgap bill; House conservatives vow to oppose",
        minutesAgo: 51,
      },
      {
        outlet: "National Review",
        lean: "right",
        title: "The Stopgap Ritual Continues",
        minutesAgo: 120,
      },
    ],
  }),
  buildStory({
    id: "c_2d91e0",
    title: "Federal appeals court reinstates emissions rule for heavy trucks",
    summary:
      "A three-judge panel ruled 2-1 that the agency acted within its statutory authority, reversing a district court stay that had frozen the rule since March.",
    updatedMinutesAgo: 64,
    sources: [
      {
        outlet: "Vox",
        lean: "left",
        title: "A big win for clean air rules, explained",
        minutesAgo: 80,
      },
      {
        outlet: "HuffPost",
        lean: "left",
        title: "Appeals Court Revives Truck Emissions Rule In Blow To Industry",
        minutesAgo: 92,
      },
      {
        outlet: "NPR",
        lean: "lean_left",
        title: "Appeals court reinstates heavy-truck emissions standards",
        minutesAgo: 76,
      },
      {
        outlet: "The Guardian (US)",
        lean: "lean_left",
        title: "Court restores truck pollution limits in setback for freight industry",
        minutesAgo: 99,
      },
      {
        outlet: "CNN",
        lean: "lean_left",
        title: "Court revives truck emissions rule",
        minutesAgo: 110,
      },
      {
        outlet: "Washington Post",
        lean: "lean_left",
        title: "Appeals court upholds agency authority on truck emissions",
        minutesAgo: 130,
      },
      {
        outlet: "Al Jazeera English",
        lean: "center",
        title: "US court reinstates emissions standards for heavy trucks",
        minutesAgo: 88,
      },
      {
        outlet: "The Hill",
        lean: "center",
        title: "Appeals court sides with agency in truck emissions case",
        minutesAgo: 101,
      },
    ],
  }),
  buildStory({
    id: "c_5b77c4",
    title: "Justice Department opens inquiry into state election board audit",
    summary:
      "Investigators have requested records covering the audit vendor contracts and chain-of-custody procedures, according to a letter reviewed by two outlets.",
    updatedMinutesAgo: 18,
    sources: [
      {
        outlet: "Fox News",
        lean: "right",
        title: "DOJ targets state election audit in latest federal overreach, officials say",
        minutesAgo: 20,
      },
      {
        outlet: "Newsmax",
        lean: "right",
        title: "Federal probe descends on state ballot audit",
        minutesAgo: 26,
      },
      {
        outlet: "The Federalist",
        lean: "right",
        title: "DOJ Investigates The Audit, Not The Election",
        minutesAgo: 35,
      },
      {
        outlet: "Daily Wire",
        lean: "right",
        title: "Justice Department demands records from state election board",
        minutesAgo: 47,
      },
      {
        outlet: "Washington Times",
        lean: "right",
        title: "DOJ requests audit vendor contracts from state board",
        minutesAgo: 58,
      },
      {
        outlet: "National Review",
        lean: "right",
        title: "A Federal Inquiry With A Thin Predicate",
        minutesAgo: 72,
      },
      {
        outlet: "New York Post",
        lean: "lean_right",
        title: "Feds open inquiry into contested ballot audit",
        minutesAgo: 30,
      },
      {
        outlet: "Washington Examiner",
        lean: "lean_right",
        title: "DOJ letter seeks chain-of-custody records from election board",
        minutesAgo: 39,
      },
      {
        outlet: "The Hill",
        lean: "center",
        title: "DOJ opens inquiry into state ballot audit",
        minutesAgo: 44,
      },
    ],
  }),
  buildStory({
    id: "c_1a44f9",
    title: "Hospital systems report a third straight quarter of nurse staffing gains",
    summary:
      "A trade association survey of 1,400 hospitals found vacancy rates down to 7.8 percent from a 2022 peak near 17 percent, though rural facilities lag badly.",
    updatedMinutesAgo: 190,
    sources: [
      {
        outlet: "NPR",
        lean: "lean_left",
        title: "Nurse staffing shortages ease, but not everywhere",
        minutesAgo: 210,
      },
      {
        outlet: "New York Times",
        lean: "lean_left",
        title: "Hospitals Report Steady Gains in Nurse Hiring",
        minutesAgo: 220,
      },
      {
        outlet: "Christian Science Monitor",
        lean: "center",
        title: "After the burnout wave: hospitals slowly rebuild nursing ranks",
        minutesAgo: 240,
      },
      {
        outlet: "Axios",
        lean: "center",
        title: "Nurse vacancy rates fall for third straight quarter",
        minutesAgo: 250,
      },
      {
        outlet: "BBC News",
        lean: "center",
        title: "US hospitals report easing nurse shortage",
        minutesAgo: 266,
      },
      {
        outlet: "The Hill",
        lean: "center",
        title: "Survey: hospital nurse vacancies down sharply from 2022 peak",
        minutesAgo: 280,
      },
      {
        outlet: "Washington Examiner",
        lean: "lean_right",
        title: "Nurse hiring recovers as travel-nurse premiums collapse",
        minutesAgo: 300,
      },
    ],
  }),
  buildStory({
    id: "c_9c02ab",
    title: "City council votes to end single-family-only zoning citywide",
    summary:
      "The 8-3 vote allows duplexes and triplexes on nearly every residential lot, making the city the largest in its state to eliminate exclusive single-family zoning.",
    updatedMinutesAgo: 320,
    sources: [
      {
        outlet: "Vox",
        lean: "left",
        title: "Another city kills single-family zoning. What actually changes.",
        minutesAgo: 330,
      },
      {
        outlet: "HuffPost",
        lean: "left",
        title: "City Council Ends Single-Family Zoning In Landmark Vote",
        minutesAgo: 340,
      },
      {
        outlet: "CNN",
        lean: "lean_left",
        title: "City scraps single-family-only zoning in bid to add housing",
        minutesAgo: 352,
      },
      {
        outlet: "The Guardian (US)",
        lean: "lean_left",
        title: "City ends exclusive single-family zoning after two-year fight",
        minutesAgo: 366,
      },
      {
        outlet: "Washington Post",
        lean: "lean_left",
        title: "Zoning overhaul clears council over neighborhood objections",
        minutesAgo: 375,
      },
      {
        outlet: "NPR",
        lean: "lean_left",
        title: "Council votes to allow duplexes on most residential lots",
        minutesAgo: 390,
      },
      {
        outlet: "New York Times",
        lean: "lean_left",
        title: "A City Bets Its Housing Future on Ending Single-Family Zoning",
        minutesAgo: 401,
      },
    ],
  }),
  buildStory({
    id: "c_63de17",
    title: "Treasury sanctions shipping network accused of moving sanctioned crude",
    summary:
      "Fourteen vessels and six management companies were designated, the largest single action against the so-called shadow fleet this year.",
    updatedMinutesAgo: 410,
    sources: [
      {
        outlet: "Reuters",
        lean: "center",
        title: "US sanctions 14 tankers over sanctioned oil shipments",
        minutesAgo: 415,
      },
      {
        outlet: "Al Jazeera English",
        lean: "center",
        title: "Washington targets shadow fleet with new sanctions",
        minutesAgo: 428,
      },
      {
        outlet: "BBC News",
        lean: "center",
        title: "US sanctions tankers accused of carrying sanctioned crude",
        minutesAgo: 440,
      },
      {
        outlet: "Axios",
        lean: "center",
        title: "Treasury hits shadow-fleet shipping network",
        minutesAgo: 455,
      },
      {
        outlet: "New York Times",
        lean: "lean_left",
        title: "U.S. Widens Sanctions on Tankers Carrying Sanctioned Oil",
        minutesAgo: 470,
      },
      {
        outlet: "Washington Examiner",
        lean: "lean_right",
        title: "Treasury sanctions tanker network in enforcement push",
        minutesAgo: 480,
      },
    ],
  }),
];

const MOCK_OUTLETS: OutletsResponse = {
  outlets: [
    {
      name: "HuffPost",
      lean: "left",
      feed_url: "https://www.huffpost.com/section/front-page/feed",
      active: true,
    },
    {
      name: "Vox",
      lean: "left",
      feed_url: "https://www.vox.com/rss/index.xml",
      active: true,
    },
    {
      name: "The Guardian (US)",
      lean: "lean_left",
      feed_url: "https://www.theguardian.com/us-news/rss",
      active: true,
    },
    {
      name: "NPR",
      lean: "lean_left",
      feed_url: "https://feeds.npr.org/1001/rss.xml",
      active: true,
    },
    {
      name: "BBC News",
      lean: "center",
      feed_url: "https://feeds.bbci.co.uk/news/rss.xml",
      active: true,
    },
    {
      name: "New York Post",
      lean: "lean_right",
      feed_url: "https://nypost.com/feed/",
      active: true,
    },
    {
      name: "Fox News",
      lean: "right",
      feed_url: "https://moxie.foxnews.com/google-publisher/latest.xml",
      active: true,
    },
  ],
};

/**
 * Mutable so the NO_DATA -> run ingest -> stories flow can actually be walked
 * through in the browser. Resets on reload, which is the point: reloading gets
 * you back to the cold-start experience.
 */
let hasIngested = false;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function mockFetchStories(): Promise<StoriesResponse> {
  await sleep(MOCK_LATENCY_MS);

  switch (MOCK_SCENARIO) {
    case "no_data":
      if (!hasIngested) {
        throw new ApiError({
          kind: "api",
          status: 503,
          code: "NO_DATA",
          url: "mock://api/stories",
          message: "No stories yet. Ingest has never run on this database.",
        });
      }
      return { generated_at: nowIso(), stories: MOCK_STORIES };

    case "empty":
      return { generated_at: nowIso(), stories: [] };

    case "error":
      throw new ApiError({
        kind: "api",
        status: 500,
        code: "INTERNAL",
        url: "mock://api/stories",
        message: "Something went wrong on the server.",
      });

    case "offline":
      throw new ApiError({
        kind: "network",
        code: "UNREACHABLE",
        url: "mock://api/stories",
        message: "Could not reach the backend.",
      });

    case "stories":
    default:
      return { generated_at: nowIso(), stories: MOCK_STORIES };
  }
}

export async function mockRunIngest(): Promise<IngestResult> {
  await sleep(MOCK_INGEST_MS);
  hasIngested = true;
  return {
    feeds_attempted: 20,
    feeds_succeeded: 18,
    feeds_failed: [
      "https://www.washingtonexaminer.com/feed",
      "https://api.axios.com/feed/",
    ],
    articles_ingested: 412,
    articles_new: 87,
    clusters_formed: 34,
    duration_seconds: MOCK_INGEST_MS / 1000,
  };
}

export async function mockFetchOutlets(): Promise<OutletsResponse> {
  await sleep(MOCK_LATENCY_MS);
  return MOCK_OUTLETS;
}
