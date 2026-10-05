import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";

// The model is scripted; the real pipeline code runs.
const ai = vi.hoisted(() => ({ create: undefined as any }));
vi.mock("@/lib/anthropic", async (orig) => ({
  ...(await orig<typeof import("@/lib/anthropic")>()),
  getClient: () => ({ messages: { create: ai.create } }),
}));

import {
  checkMergeGroups,
  MAX_SEAM_PHOTOS,
  sortPhotos,
} from "@/lib/sortPipeline";
import { buildVerifyMergePrompt } from "@/lib/prompts";
import { POST as sortRoute } from "@/app/api/sort/route";
import { POST as mergeCheckRoute } from "@/app/api/merge-check/route";
import type { WireImage } from "@/lib/images";

const img = (n: number): WireImage => ({
  mediaType: "image/jpeg",
  data: Buffer.from(`photo-${n}`).toString("base64"),
});
const imgs = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => img(from + i));
const reply = (json: unknown) =>
  ({
    content: [{ type: "text", text: JSON.stringify(json) }],
  }) as unknown as Anthropic.Message;
const lastText = (call: any[]) =>
  call[0].messages[0].content.filter((b: any) => b.type === "text").at(-1).text;
const imageData = (call: any[]) =>
  call[0].messages[0].content
    .filter((b: any) => b.type === "image")
    .map((b: any) => b.source.data);

let ip = 0;
const post = (url: string, body: unknown) =>
  new NextRequest(`https://test.example${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-secret": "unit-secret",
      // A fresh client address per request keeps the rate limiter out of it.
      "x-forwarded-for": `10.0.${Math.floor(++ip / 250)}.${ip % 250}`,
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.stubEnv("APP_SECRET", "unit-secret");
  ai.create = vi.fn();
});
afterEach(() => vi.unstubAllEnvs());

describe("one shared same-item decision", () => {
  it("the boundary check sends exactly the in-request merge prompt and model", async () => {
    // In-request: two groups of one photo each get a merge vote.
    ai.create.mockImplementation(async (params: any) => {
      const text = lastText([params]);
      if (/group these numbered photos/i.test(text))
        return reply({
          groups: [
            { folder_name: "a", photo_indices: [1] },
            { folder_name: "b", photo_indices: [2] },
          ],
        });
      return reply({ merge: false, valid: true });
    });
    await sortPhotos({ messages: { create: ai.create } } as any, imgs(0, 2));
    const inRequest = ai.create.mock.calls.find((c: any[]) =>
      /--- Group B ---/.test(JSON.stringify(c[0].messages[0].content)),
    );
    expect(inRequest).toBeDefined();
    expect(lastText(inRequest)).toBe(buildVerifyMergePrompt(1, 1));

    ai.create.mockClear();
    ai.create.mockResolvedValue(reply({ merge: true }));
    const a = imgs(10, 5);
    const b = imgs(20, 3);
    expect(
      await checkMergeGroups({ messages: { create: ai.create } } as any, a, b),
    ).toBe(true);
    const [call] = ai.create.mock.calls;
    expect(lastText(call)).toBe(buildVerifyMergePrompt(5, 3));
    expect(call[0].model).toBe(inRequest[0].model);
    // Several photos per side, side A first, separated as in-request.
    expect(imageData(call)).toEqual([...a, ...b].map((x) => x.data));
    expect(JSON.stringify(call[0].messages[0].content)).toContain(
      "--- Group B ---",
    );
  });

  it("returns false when the AI says different items, null when the check cannot run", async () => {
    const client = { messages: { create: ai.create } } as any;
    ai.create.mockResolvedValue(reply({ merge: false }));
    expect(await checkMergeGroups(client, imgs(0, 2), imgs(2, 2))).toBe(false);
    // A non-retryable API failure: the check could not run.
    ai.create.mockRejectedValue(
      Object.assign(new Error("bad"), { status: 400 }),
    );
    expect(await checkMergeGroups(client, imgs(0, 2), imgs(2, 2))).toBeNull();
    // No time left: never a guess.
    ai.create.mockResolvedValue(reply({ merge: true }));
    expect(
      await checkMergeGroups(client, imgs(0, 2), imgs(2, 2), undefined, 0),
    ).toBeNull();
    // Over the photo bound, or an empty side: not checked.
    expect(
      await checkMergeGroups(client, imgs(0, 13), imgs(13, 12)),
    ).toBeNull();
    expect(await checkMergeGroups(client, [], imgs(0, 2))).toBeNull();
    expect(MAX_SEAM_PHOTOS).toBe(24);
  });
});

describe("/api/merge-check", () => {
  it("compares several photos per side and answers merge true/false", async () => {
    ai.create.mockResolvedValue(reply({ merge: true }));
    const res = await mergeCheckRoute(
      post("/api/merge-check", { a: imgs(0, 12), b: imgs(12, 3) }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, merge: true });
    expect(imageData(ai.create.mock.calls[0])).toHaveLength(15);
    ai.create.mockResolvedValue(reply({ merge: false }));
    const no = await mergeCheckRoute(
      post("/api/merge-check", { a: imgs(0, 2), b: imgs(2, 2) }),
    );
    expect(await no.json()).toEqual({ ok: true, merge: false });
  });

  it("reports a check that could not run as a failure, never as an answer", async () => {
    ai.create.mockRejectedValue(
      Object.assign(new Error("bad"), { status: 400 }),
    );
    const res = await mergeCheckRoute(
      post("/api/merge-check", { a: imgs(0, 2), b: imgs(2, 2) }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("rejects missing, invalid or too many photos", async () => {
    for (const body of [
      {},
      { a: imgs(0, 2) },
      { a: [], b: imgs(0, 2) },
      { a: [{ mediaType: "text/html", data: "eA==" }], b: imgs(0, 1) },
      { a: imgs(0, 13), b: imgs(13, 12) },
    ]) {
      const res = await mergeCheckRoute(post("/api/merge-check", body));
      expect(res.status).toBe(400);
    }
    expect(ai.create).not.toHaveBeenCalled();
  });
});

describe("/api/sort photo limit", () => {
  it("refuses more than 120 photos instead of silently dropping some", async () => {
    const res = await sortRoute(post("/api/sort", { images: imgs(0, 121) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "Too many photos in one sort request (121); the limit is 120.",
    });
    expect(ai.create).not.toHaveBeenCalled();
  });

  it("still sorts a request of exactly 120 photos", async () => {
    ai.create.mockImplementation(async (params: any) =>
      /group these numbered photos/i.test(lastText([params]))
        ? reply({ groups: [{ folder_name: "tee", photo_indices: [] }] })
        : reply({ valid: true, merge: false }),
    );
    const res = await sortRoute(post("/api/sort", { images: imgs(0, 120) }));
    // Reaches the sorter (which here finds no groups) — not refused.
    expect(res.status).not.toBe(400);
    expect(ai.create).toHaveBeenCalled();
  });
});
