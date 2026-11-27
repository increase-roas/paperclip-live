import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchNeonAdsAccounts,
  fetchNeonAdsPipeline,
  fetchSalesCapital,
  fetchSalesSnapshots,
} from "../sales-dashboard-client.js";

const BASE = "https://dash.example";
const OPTS = { baseUrl: BASE, adminKey: "test-key" };
const SNAPSHOTS_URL = `${BASE}/api/pilot/admin/snapshots?view=30d`;
const LEGACY_URL = `${BASE}/api/pilot/dashboard?view=30d`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Handler returns a Response as-is, a plain value as a 200 JSON body, or undefined for a 404. */
function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const out = await handler(url, init);
    if (out instanceof Response) return out;
    return out === undefined ? json({}, 404) : json(out);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, urls: () => calls.map((c) => c.url) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("sales dashboard transport", () => {
  it("makes no request when the admin key is blank, even if the env has one", async () => {
    vi.stubEnv("SALES_DASHBOARD_ADMIN_KEY", "env-key");
    const { fetchImpl } = stubFetch(() => ({ ok: true, clients: [] }));

    await expect(fetchSalesCapital("30d", { ...OPTS, adminKey: "   ", fetchImpl })).resolves.toBeNull();
    await expect(fetchSalesSnapshots("30d", { ...OPTS, adminKey: "", fetchImpl })).resolves.toBeNull();
    await expect(fetchNeonAdsAccounts({ ...OPTS, adminKey: "", fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the trimmed bearer key, never follows redirects, and strips trailing slashes from the base URL", async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ ok: true, clients: [] }));

    await fetchSalesCapital("month", { baseUrl: `${BASE}//`, adminKey: "  secret  ", fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/pilot/admin/capital?view=month`);
    expect(calls[0].init).toMatchObject({
      redirect: "manual",
      headers: {
        authorization: "Bearer secret",
        accept: "application/json",
        "user-agent": "paperclip-server/1.0",
      },
    });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads the base URL and admin key from the environment when no options are given", async () => {
    vi.stubEnv("SALES_DASHBOARD_BASE_URL", " https://env-dash.example/ ");
    vi.stubEnv("SALES_DASHBOARD_ADMIN_KEY", "env-key");
    const { fetchImpl, calls } = stubFetch(() => ({ ok: true, clients: [] }));

    await fetchSalesCapital("7d", { fetchImpl });

    expect(calls[0].url).toBe("https://env-dash.example/api/pilot/admin/capital?view=7d");
    expect(calls[0].init.headers).toMatchObject({ authorization: "Bearer env-key" });
  });

  it("returns null for error statuses, redirects, unreachable servers and bad JSON", async () => {
    const responses: Array<() => Response> = [
      () => json({ ok: true, clients: [] }, 401),
      () => json({ ok: true, clients: [] }, 500),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("<html>not json</html>", { status: 200 }),
    ];
    for (const respond of responses) {
      const { fetchImpl } = stubFetch(respond);
      await expect(fetchSalesCapital("30d", { ...OPTS, fetchImpl })).resolves.toBeNull();
    }
  });

  it("aborts a hung request after timeoutMs and returns null", async () => {
    let signal: AbortSignal | undefined;
    const { fetchImpl } = stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    await expect(fetchSalesCapital("30d", { ...OPTS, fetchImpl, timeoutMs: 5 })).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});

describe("fetchSalesCapital", () => {
  it("rejects ok:false bodies and bodies with no owner, clients or operating section", async () => {
    for (const body of [{ ok: false, owner: { slug: "x" }, clients: [] }, { ok: true, view: "30d" }]) {
      const { fetchImpl } = stubFetch(() => body);
      await expect(fetchSalesCapital("30d", { ...OPTS, fetchImpl })).resolves.toBeNull();
    }
  });

  it("fills safe defaults and keeps the upstream view so callers can detect a period mismatch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-27T09:00:00.000Z"));
    const operating = { monthlyLaborUsd: 1, monthlyOverheadUsd: 2, monthlyBurnUsd: 3, runwayMonths: null };

    const withOperatingOnly = stubFetch(() => ({ operating, members: "nope", clients: "nope" }));
    await expect(fetchSalesCapital("7d", { ...OPTS, fetchImpl: withOperatingOnly.fetchImpl })).resolves.toEqual({
      generatedAt: "2026-11-27T09:00:00.000Z",
      view: "7d",
      members: [],
      operating,
      settings: null,
      owner: null,
      clients: [],
    });

    const wrongWindow = stubFetch(() => ({ view: "30d", generatedAt: "2026-11-01T00:00:00.000Z", clients: [] }));
    const capital = await fetchSalesCapital("month", { ...OPTS, fetchImpl: wrongWindow.fetchImpl });
    expect(capital?.view).toBe("30d");
    expect(capital?.generatedAt).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("fetchSalesSnapshots", () => {
  it("parses summary, payload.summary and flat client shapes, unwrapping only LIVE sections", async () => {
    const { fetchImpl, urls } = stubFetch((url) =>
      url === SNAPSHOTS_URL
        ? {
            ok: true,
            view: "30d",
            generatedAt: "2026-11-27T00:00:00.000Z",
            clients: [
              {
                slug: "  acme-spas ",
                displayName: " Acme Spas ",
                syncedAt: "2026-11-26T10:00:00.000Z",
                lastSuccessfulSyncAt: "2026-11-25T10:00:00.000Z",
                summary: {
                  ghl: { status: "LIVE", data: { newLeads: 40, wonDeals: 4 } },
                  meta: { status: "STALE", data: { spend: 9999 } },
                  cash: { cashCollectedUsd: 1200 },
                  companyFinancials: { status: "LIVE", data: { totalSalesUsd: 5000 } },
                },
              },
              {
                slug: "globex-pools",
                lastSuccessfulSyncAt: "2026-11-25T10:00:00.000Z",
                payload: { summary: { meta: { status: "LIVE", spend: 300 }, ghl: ["not", "a", "section"] } },
              },
              { generatedAt: "2026-11-24T10:00:00.000Z", ghl: { newLeads: 5 } },
            ],
          }
        : undefined,
    );

    const snapshots = await fetchSalesSnapshots("30d", { ...OPTS, fetchImpl });

    expect(urls()).toEqual([SNAPSHOTS_URL]);
    expect(snapshots?.observedAt).toBe("2026-11-27T00:00:00.000Z");
    expect(snapshots?.owner).toBeNull();
    expect(snapshots?.clients).toEqual([
      {
        slug: "acme-spas",
        displayName: "Acme Spas",
        observedAt: "2026-11-26T10:00:00.000Z",
        ghl: { newLeads: 40, wonDeals: 4 },
        meta: undefined,
        cash: { cashCollectedUsd: 1200 },
        financials: { totalSalesUsd: 5000 },
      },
      {
        slug: "globex-pools",
        displayName: "globex-pools",
        observedAt: "2026-11-25T10:00:00.000Z",
        ghl: undefined,
        meta: { status: "LIVE", spend: 300 },
        cash: undefined,
        financials: undefined,
      },
      {
        slug: "client-3",
        displayName: "Client",
        observedAt: "2026-11-24T10:00:00.000Z",
        ghl: { newLeads: 5 },
        meta: undefined,
        cash: undefined,
        financials: undefined,
      },
    ]);
  });

  it("fills meta.zeroLeadDays from zeroLeadDays7d without overriding a value the meta section already has", async () => {
    const { fetchImpl } = stubFetch(() => ({
      view: "30d",
      clients: [
        { slug: "a", zeroLeadDays7d: 3, summary: { meta: { spend: 10 } } },
        { slug: "b", zeroLeadDays7d: 3, summary: { meta: { spend: 10, zeroLeadDays: 0 } } },
        { slug: "c", zeroLeadDays7d: 2, summary: { ghl: { newLeads: 0 } } },
        { slug: "d", zeroLeadDays7d: Number.NaN, summary: { ghl: { newLeads: 1 } } },
      ],
    }));

    const metaBySlug = Object.fromEntries(
      ((await fetchSalesSnapshots("30d", { ...OPTS, fetchImpl }))?.clients ?? []).map((c) => [c.slug, c.meta]),
    );

    expect(metaBySlug).toEqual({
      a: { spend: 10, zeroLeadDays: 3 },
      b: { spend: 10, zeroLeadDays: 0 },
      c: { zeroLeadDays: 2 },
      d: undefined,
    });
  });

  it("skips entries with no summary, reads the snapshots array, and drops a duplicate owner row", async () => {
    const ownerRow = { slug: "__owner__", summary: { cash: { cashCollectedUsd: 1 } } };
    const withOwner = stubFetch(() => ({
      owner: { summary: { cash: { cashCollectedUsd: 9000 } } },
      snapshots: [null, "junk", { slug: "empty" }, ownerRow, { slug: "kept", summary: { ghl: { newLeads: 1 } } }],
    }));

    const snapshots = await fetchSalesSnapshots("30d", { ...OPTS, fetchImpl: withOwner.fetchImpl });

    expect(snapshots?.owner).toMatchObject({
      slug: "__owner__",
      displayName: "IR / HTL owner",
      cash: { cashCollectedUsd: 9000 },
    });
    expect(snapshots?.clients.map((c) => c.slug)).toEqual(["kept"]);

    const withoutOwner = stubFetch(() => ({ clients: [ownerRow] }));
    const ownerless = await fetchSalesSnapshots("30d", { ...OPTS, fetchImpl: withoutOwner.fetchImpl });
    expect(ownerless?.owner).toBeNull();
    expect(ownerless?.clients.map((c) => c.slug)).toEqual(["__owner__"]);
  });

  it("returns null for a different period instead of falling back to the legacy endpoint", async () => {
    const { fetchImpl, urls } = stubFetch((url) =>
      url === SNAPSHOTS_URL
        ? { view: "month", clients: [{ slug: "a", summary: { ghl: { newLeads: 1 } } }] }
        : { view: "30d", summary: { ghl: { newLeads: 99 } } },
    );

    await expect(fetchSalesSnapshots("30d", { ...OPTS, fetchImpl })).resolves.toBeNull();
    expect(urls()).toEqual([SNAPSHOTS_URL]);
  });

  it("falls back to the legacy single-tenant dashboard as the owner when the multi-client endpoint is unusable", async () => {
    for (const multi of [undefined, { ok: false, clients: [] }, { ok: true, view: "30d" }]) {
      const { fetchImpl, urls } = stubFetch((url) =>
        url === SNAPSHOTS_URL
          ? multi
          : {
              view: "30d",
              lastSuccessfulSyncAt: "2026-11-26T08:00:00.000Z",
              generatedAt: "2026-11-27T08:00:00.000Z",
              summary: { ghl: { status: "LIVE", data: { newLeads: 12 } } },
            },
      );

      await expect(fetchSalesSnapshots("30d", { ...OPTS, fetchImpl })).resolves.toEqual({
        observedAt: "2026-11-26T08:00:00.000Z",
        owner: {
          slug: "__owner__",
          displayName: "IR / HTL owner",
          observedAt: "2026-11-26T08:00:00.000Z",
          ghl: { newLeads: 12 },
          meta: undefined,
          cash: undefined,
          financials: undefined,
        },
        clients: [],
      });
      expect(urls()).toEqual([SNAPSHOTS_URL, LEGACY_URL]);
    }
  });

  it("returns null when the legacy dashboard is for another period or has no summary", async () => {
    for (const legacy of [{ view: "7d", summary: { ghl: { newLeads: 1 } } }, { view: "30d" }, undefined]) {
      const { fetchImpl } = stubFetch((url) => (url === LEGACY_URL ? legacy : undefined));
      await expect(fetchSalesSnapshots("30d", { ...OPTS, fetchImpl })).resolves.toBeNull();
    }
  });
});

describe("Neon ads fetchers", () => {
  it("accept only LIVE bodies with a clients array", async () => {
    for (const body of [{ status: "STALE", clients: [] }, { status: "LIVE", clients: {} }, { ok: true, clients: [] }]) {
      const { fetchImpl } = stubFetch(() => body);
      await expect(fetchNeonAdsAccounts({ ...OPTS, fetchImpl })).resolves.toBeNull();
      await expect(fetchNeonAdsPipeline({ ...OPTS, fetchImpl })).resolves.toBeNull();
    }

    const { fetchImpl, urls } = stubFetch(() => ({
      status: "LIVE",
      generatedAt: "2026-11-27T01:00:00.000Z",
      latestDataDay: 20261126,
      clients: [],
    }));
    await expect(fetchNeonAdsAccounts({ ...OPTS, fetchImpl })).resolves.toEqual({
      observedAt: "2026-11-27T01:00:00.000Z",
      latestDataDay: null,
      clients: [],
    });
    expect(urls()).toEqual([`${BASE}/api/pilot/neon-ads?view=accounts`]);
  });

  it("reads the pipeline period from period, then window, and leaves unknown periods unscoped", async () => {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ period: "month", window: "7d" }, "month"],
      [{ period: "90d", window: { days: 7 } }, "7d"],
      [{ window: { days: 30 } }, "30d"],
      [{ window: { view: "month" } }, "month"],
      [{ window: { period: "7d", view: "30d" } }, "7d"],
      [{ window: { days: 14 } }, null],
      [{ window: ["7d"] }, null],
      [{}, null],
    ];
    for (const [declared, expected] of cases) {
      const { fetchImpl } = stubFetch(() => ({ status: "LIVE", clients: [], ...declared }));
      const pipeline = await fetchNeonAdsPipeline({ ...OPTS, fetchImpl });
      expect(pipeline?.period, JSON.stringify(declared)).toBe(expected);
    }
  });
});
