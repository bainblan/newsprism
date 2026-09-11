/**
 * lib/api.ts — the contract boundary.
 *
 * Everything here mocks global `fetch`; nothing hits a network. This file
 * covers: status/envelope -> ApiError mapping, isNoData/isNotFound/network
 * discrimination, a malformed error envelope falling back to UNKNOWN, a 200
 * with unparseable JSON becoming UNPARSEABLE, the minSources -> min_sources
 * wire-name mapping, fetchStory's envelope unwrap + id URL-encoding, and the
 * POST method for ingest.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, fetchOutlets, fetchStories, fetchStory, runIngest } from "@/lib/api";
import { makeStory } from "@/test/fixtures";

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, init: { status?: number } = {}) {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("lib/api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("fetchStories", () => {
    it("sends minSources on the wire as min_sources, and limit unchanged", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ generated_at: "2026-09-10T00:00:00Z", stories: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await fetchStories({ limit: 25, minSources: 3 });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      const url = new URL(calledUrl);
      expect(url.searchParams.get("limit")).toBe("25");
      expect(url.searchParams.get("min_sources")).toBe("3");
      expect(url.searchParams.has("minSources")).toBe(false);
    });

    it("omits params that were not provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ generated_at: "2026-09-10T00:00:00Z", stories: [] }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await fetchStories();

      const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      const url = new URL(calledUrl);
      expect(url.searchParams.has("limit")).toBe(false);
      expect(url.searchParams.has("min_sources")).toBe(false);
    });

    it("resolves with the parsed body on 200", async () => {
      const payload = { generated_at: "2026-09-10T00:00:00Z", stories: [makeStory()] };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

      const result = await fetchStories();
      expect(result).toEqual(payload);
    });

    it("maps 503 NO_DATA to an ApiError with isNoData true", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(
            { error: { code: "NO_DATA", message: "empty database" } },
            { status: 503 },
          ),
        ),
      );

      await expect(fetchStories()).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.kind).toBe("api");
        expect(apiError.status).toBe(503);
        expect(apiError.code).toBe("NO_DATA");
        expect(apiError.isNoData).toBe(true);
        expect(apiError.isNotFound).toBe(false);
        return true;
      });
    });

    it("maps 404 NOT_FOUND to an ApiError with isNotFound true, isNoData false", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(
            { error: { code: "NOT_FOUND", message: "no such story" } },
            { status: 404 },
          ),
        ),
      );

      await expect(fetchStories()).rejects.toSatisfy((error: unknown) => {
        const apiError = error as ApiError;
        expect(apiError.isNotFound).toBe(true);
        expect(apiError.isNoData).toBe(false);
        return true;
      });
    });

    it("falls back to code UNKNOWN when the error envelope is malformed", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ oops: "not an envelope" }, { status: 500 })),
      );

      await expect(fetchStories()).rejects.toSatisfy((error: unknown) => {
        const apiError = error as ApiError;
        expect(apiError.kind).toBe("api");
        expect(apiError.code).toBe("UNKNOWN");
        expect(apiError.status).toBe(500);
        return true;
      });
    });

    it("produces code UNPARSEABLE for a 200 whose body is not valid JSON", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("not json {{{")));

      await expect(fetchStories()).rejects.toSatisfy((error: unknown) => {
        const apiError = error as ApiError;
        expect(apiError.kind).toBe("api");
        expect(apiError.code).toBe("UNPARSEABLE");
        return true;
      });
    });

    it("maps a rejected fetch (no HTTP response at all) to kind network", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

      await expect(fetchStories()).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.kind).toBe("network");
        expect(apiError.isNoData).toBe(false);
        expect(apiError.isNotFound).toBe(false);
        return true;
      });
    });
  });

  describe("fetchStory", () => {
    it("unwraps the { story } envelope", async () => {
      const story = makeStory({ id: "s_abc123" });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ story })));

      const result = await fetchStory("s_abc123");
      expect(result).toEqual(story);
    });

    it("URL-encodes the id it is given", async () => {
      const story = makeStory({ id: "weird id/with slash" });
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ story }));
      vi.stubGlobal("fetch", fetchMock);

      await fetchStory("weird id/with slash");

      const [calledUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toContain(encodeURIComponent("weird id/with slash"));
      expect(calledUrl).not.toContain("stories/weird id/with slash");
    });

    it("surfaces 404 as isNotFound", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse({ error: { code: "NOT_FOUND", message: "gone" } }, { status: 404 }),
        ),
      );

      await expect(fetchStory("missing")).rejects.toSatisfy((error: unknown) => {
        expect((error as ApiError).isNotFound).toBe(true);
        return true;
      });
    });
  });

  describe("runIngest", () => {
    it("issues a POST", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          feeds_attempted: 1,
          feeds_succeeded: 1,
          feeds_failed: [],
          articles_ingested: 1,
          articles_new: 1,
          clusters_formed: 1,
          duration_seconds: 1,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await runIngest();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
    });
  });

  describe("fetchOutlets", () => {
    it("resolves with the parsed body", async () => {
      const payload = { outlets: [] };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));

      const result = await fetchOutlets();
      expect(result).toEqual(payload);
    });
  });
});
