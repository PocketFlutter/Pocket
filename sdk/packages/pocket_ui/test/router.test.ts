import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  PocketRouteScope,
  PocketRouterProvider,
  createPocketRouter,
  createRouteMatcher,
  decodeUriPart,
  encodeUriPart,
  extractLinkUri,
  fillRoutePattern,
  parsePocketUri,
  parseSearchString,
  stateParam,
  stringifySearchRecord,
  useLocation,
  useRouteParams,
  useSearchState,
  useSearchStates,
  type InferRouteParams,
  type MiniAppDeepLinkPayload,
} from "../src/router.tsx";
import { createHostBridge } from "../src/host.ts";
import { createPlatformExperience } from "../src/platform-experience.ts";

describe("@pocket/ui/router — URI parser & RFC-3986 codecs", () => {
  test("encodes and decodes UTF-8 CJK, emoji, and query '+' safely without Web TextEncoder", () => {
    const raw = "状态直达 🚀 + 100%";
    const encoded = encodeUriPart(raw);
    expect(encoded).not.toContain(" ");
    expect(decodeUriPart(encoded)).toBe(raw);
    expect(decodeUriPart("Hello+Pocket%21", true)).toBe("Hello Pocket!");
    // Malformed trailing % must not throw in QuickJS
    expect(decodeUriPart("100%raw%2", false)).toBe("100%raw%2");
  });

  test("parses full pocket:// URIs, mobile shorthand authorities, web URLs, and dot segments", () => {
    const full = parsePocketUri(
      "pocket://showcase/skins/controls?skin=arc&mode=amber-night&quota=85#palette",
    );
    expect(full.scheme).toBe("pocket");
    expect(full.authority).toBe("showcase");
    expect(full.pathname).toBe("/skins/controls");
    expect(full.decodedSegments).toEqual(["skins", "controls"]);
    expect(full.query).toEqual({
      skin: "arc",
      mode: "amber-night",
      quota: "85",
    });
    expect(full.hash).toBe("palette");

    // Mobile custom-scheme shorthand: `pocket://skins/controls` -> `/skins/controls`
    const shorthand = parsePocketUri("pocket://skins/controls?quota=90");
    expect(shorthand.pathname).toBe("/skins/controls");
    expect(shorthand.uri).toBe("pocket://showcase/skins/controls?quota=90");

    // Dot-segment normalization (`rou3` normalize semantics)
    const normalized = parsePocketUri("/gallery/sub/../skins/./overlays");
    expect(normalized.pathname).toBe("/gallery/skins/overlays");
  });

  test("prevents prototype pollution and Object.prototype method collisions in query parsing", () => {
    const parsed = parseSearchString(
      "?z=last&a=first&__proto__=polluted&constructor=bad&toString=1&toString=2&hasOwnProperty=yes&tag=one&tag=two",
    );
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "constructor")).toBe(false);
    expect(parsed.toString).toEqual(["1", "2"]);
    expect(parsed.hasOwnProperty).toBe("yes");
    expect(parsed.a).toBe("first");
    expect(parsed.tag).toEqual(["one", "two"]);
    expect(stringifySearchRecord(parsed)).toBe(
      "?a=first&hasOwnProperty=yes&tag=one&tag=two&toString=1&toString=2&z=last",
    );
  });
});

describe("@pocket/ui/router — Radix pattern matcher & specificity ranking", () => {
  test("ranks static > regex-constrained > required param > optional param > wildcard", () => {
    const matcher = createRouteMatcher<string>();
    matcher.add("/**rest", "catch-all");
    matcher.add("/items/:id?", "optional-param");
    matcher.add("/items/:slug", "required-param");
    matcher.add("/items/:id(\\d+)", "numeric-param");
    matcher.add("/items/featured", "static-featured");

    expect(matcher.match("/items/featured")?.data).toBe("static-featured");
    expect(matcher.match("/items/42")?.data).toBe("numeric-param");
    expect(matcher.match("/items/42")?.params).toEqual({ id: "42" });
    expect(matcher.match("/items/notebook")?.data).toBe("required-param");
    expect(matcher.match("/items/notebook")?.params).toEqual({ slug: "notebook" });
    expect(matcher.match("/items")?.data).toBe("optional-param");
    expect(matcher.match("/items")?.params).toEqual({});
    expect(matcher.match("/docs/guide/intro")?.data).toBe("catch-all");
    expect(matcher.match("/docs/guide/intro")?.params).toEqual({ rest: "docs/guide/intro" });
  });

  test("fills route patterns and checks compile-time InferRouteParams including wildcards", () => {
    type Params = InferRouteParams<"/orgs/:orgId/skins/:tab?">;
    type CatchAll = InferRouteParams<"/docs/**:rest">;
    const sample: Params = { orgId: "tryjoy", tab: "controls" };
    const catchAllSample: CatchAll = { rest: "v1/intro" };
    expect(sample.orgId).toBe("tryjoy");
    expect(catchAllSample.rest).toBe("v1/intro");

    expect(fillRoutePattern("/orgs/:orgId/skins/:tab?", { orgId: "tryjoy" })).toBe(
      "/orgs/tryjoy/skins",
    );
    expect(
      fillRoutePattern("/orgs/:orgId/skins/:tab?", { orgId: "tryjoy", tab: "overlays" }),
    ).toBe("/orgs/tryjoy/skins/overlays");
  });
});

describe("@pocket/ui/router — Typed state codecs & Base64URL snapshots", () => {
  test("parses, clamps, guards invalid enum defaults, and round-trips Base64URL snapshots", () => {
    const quotaCodec = stateParam.int(72, { min: 10, max: 100 });
    expect(quotaCodec.parse("85")).toBe(85);
    expect(quotaCodec.parse("999")).toBe(100);
    expect(quotaCodec.parse("-5")).toBe(10);
    expect(quotaCodec.parse("not-a-number")).toBe(72);

    const modeCodec = stateParam.enum(["light", "dark", "amber-night"] as const, "light");
    expect(modeCodec.parse("amber-night")).toBe("amber-night");
    expect(modeCodec.parse("invalid-mode")).toBe("light");

    // Runtime guard if an unvalidated dynamic value is cast into defaultValue
    const safeEnum = stateParam.enum(
      ["blue", "coral", "violet", "green"] as const,
      "teal" as unknown as "blue",
    );
    expect(safeEnum.defaultValue).toBe("blue");

    const boolCodec = stateParam.boolean(false);
    expect(boolCodec.parse("1")).toBe(true);
    expect(boolCodec.parse("true")).toBe(true);
    expect(boolCodec.parse("0")).toBe(false);
    expect(boolCodec.parse("unexpected")).toBe(false);

    const snapshotCodec = stateParam.snapshot({
      title: "状态直达快照",
      tags: ["arc", "looseleaf"],
      step: 3,
    });
    const token = snapshotCodec.serialize({
      title: "Deep-Link 100% ÿû 🚀",
      tags: ["solid", "quickjs"],
      step: 7,
    });
    expect(typeof token).toBe("string");
    expect(String(token)).not.toContain("=");
    expect(String(token)).not.toContain("+");
    expect(String(token)).not.toContain("/");
    expect(snapshotCodec.parse(token)).toEqual({
      title: "Deep-Link 100% ÿû 🚀",
      tags: ["solid", "quickjs"],
      step: 7,
    });
    // Corrupted or illegal 1-mod-4 length Base64 tokens fall back safely
    expect(snapshotCodec.parse("%%%corrupted%%%")).toEqual({
      title: "状态直达快照",
      tags: ["arc", "looseleaf"],
      step: 3,
    });
    expect(snapshotCodec.parse("abcde")).toEqual({
      title: "状态直达快照",
      tags: ["arc", "looseleaf"],
      step: 3,
    });
  });
});

describe("@pocket/ui/router — Stack synthesis, guards, SolidJS hooks & Host link bridge", () => {
  test("synthesizes parent back-stack with retained params, handles pattern+query navigation, and preserves change reasons", () => {
    const miniAppCalls: MiniAppDeepLinkPayload[] = [];
    const changeReasons: string[] = [];
    const router = createPocketRouter({
      routes: [
        { id: "home", path: "/home", aliases: ["/"], primary: true },
        { id: "gallery", path: "/gallery", aliases: ["/ui"], primary: true, parent: "home" },
        {
          id: "skins",
          path: "/skins/:tab?",
          parent: "gallery",
          searchSchema: {
            skin: stateParam.enum(["default", "looseleaf", "arc"] as const, "default"),
            quota: stateParam.int(72, { min: 10, max: 100 }),
            dialog: stateParam.boolean(false),
          },
        },
        {
          id: "legacy",
          path: "/old-skins",
          redirectTo: "/skins/controls?skin=arc&quota=90",
        },
        {
          id: "locked",
          path: "/locked",
          beforeEnter: ({ to }) => (to.query.token === "ok" ? true : "/home?denied=1"),
        },
      ],
      retainParams: ["skin"],
      onMiniAppLink: (payload) => {
        miniAppCalls.push(payload);
      },
      onChange: (_entry, _stack, reason) => {
        changeReasons.push(reason);
      },
    });

    // `resolve()` is read-only and does not mutate stack or emit `onChange`
    const preview = router.resolve("/skins/:tab?quota=91#top", { params: { tab: "controls" } });
    expect(preview?.pathname).toBe("/skins/controls");
    expect(preview?.query.quota).toBe("91");
    expect(preview?.hash).toBe("top");
    expect(changeReasons.length).toBe(0);

    // Deep-link into `/skins/overlays?skin=looseleaf&dialog=1&quota=72` (default quota=72 strips!)
    const res = router.openDeepLink(
      "pocket://showcase/skins/overlays?skin=looseleaf&dialog=1&quota=72",
    );
    expect(res.handled).toBe(true);
    expect(res.kind).toBe("route");
    expect(changeReasons[changeReasons.length - 1]).toBe("deeplink");
    expect(router.current().routeId).toBe("skins");
    expect(router.params()).toEqual({ tab: "overlays" });
    expect(router.current().state).toEqual({
      skin: "looseleaf",
      quota: 72,
      dialog: true,
    });
    expect(router.uri()).toBe("pocket://showcase/skins/overlays?dialog=1&skin=looseleaf");
    expect(router.stack().map((e) => e.routeId)).toEqual(["gallery", "skins"]);

    // `setSearch` emits `"search"` (not `"replace"`)
    router.setSearch((prev) => ({ ...prev, quota: 80 }));
    expect(changeReasons[changeReasons.length - 1]).toBe("search");

    // Pop back lands on synthesized parent `/gallery` AND retains `skin=looseleaf`!
    expect(router.back()).toBe(true);
    expect(changeReasons[changeReasons.length - 1]).toBe("pop");
    expect(router.current().routeId).toBe("gallery");
    expect(router.query().skin).toBe("looseleaf");
    expect(router.canGoBack()).toBe(false);

    // Pattern + query + hash navigation in one call
    router.navigate("/skins/:tab?quota=84#controls", { params: { tab: "controls" } });
    expect(router.uri()).toBe(
      "pocket://showcase/skins/controls?quota=84&skin=looseleaf#controls",
    );

    // Explicit `_stack` overrides parent chain and safely round-trips commas inside segments
    router.openDeepLink(
      "pocket://showcase/skins/controls?skin=arc&_stack=/home,/gallery",
    );
    expect(router.stack().map((e) => e.routeId)).toEqual(["home", "gallery", "skins"]);

    const commaStackRouter = createPocketRouter({
      routes: [
        { id: "home", path: "/home", primary: true },
        { id: "filter", path: "/filter/:tags", parent: "home" },
        { id: "detail", path: "/detail", parent: "filter" },
      ],
    });
    const encodedCommaUri = commaStackRouter.buildUri("/detail", {
      includeStack: ["/home", "/filter/milk,soy"],
    });
    commaStackRouter.openDeepLink(encodedCommaUri);
    expect(commaStackRouter.stack().map((e) => e.routeId)).toEqual([
      "home",
      "filter",
      "detail",
    ]);
    commaStackRouter.back();
    expect(commaStackRouter.current().routeId).toBe("filter");
    expect(commaStackRouter.params().tags).toBe("milk,soy");

    // Redirect route
    router.navigate("/old-skins");
    expect(router.current().routeId).toBe("skins");
    expect(router.params().tab).toBe("controls");
    expect(router.current().state.quota).toBe(90);

    // Guard redirect
    router.navigate("/locked");
    expect(router.current().routeId).toBe("home");
    expect(router.query().denied).toBe("1");

    // Cross-boundary MiniApp URI
    const appRes = router.openDeepLink(
      "pocket://app/pocket.demo.profile/security?style=sheet&from=deeplink",
    );
    expect(appRes.kind).toBe("miniapp");
    expect(miniAppCalls.length).toBe(1);
    expect(miniAppCalls[0]?.appId).toBe("pocket.demo.profile");
    expect(miniAppCalls[0]?.subPath).toBe("/security");
    expect(miniAppCalls[0]?.presentationStyle).toBe("sheet");
  });

  test("two-way SolidJS hooks read background stack frames on cold mount and preserve signals after pop", () => {
    const router = createPocketRouter({
      initialUrl: "pocket://showcase/router?_stack=/gallery,/skins/controls%3Fquota%3D91",
      routes: [
        { id: "home", path: "/home", primary: true },
        { id: "gallery", path: "/gallery", primary: true },
        { id: "skins", path: "/skins/:tab?", parent: "gallery" },
        { id: "router", path: "/router", parent: "gallery" },
      ],
    });

    // Foreground is `/router`, while `/skins/controls?quota=91` sits underneath in `router.stack()`
    expect(router.current().routeId).toBe("router");
    expect(router.stack().map((e) => e.routeId)).toEqual(["gallery", "skins", "router"]);

    createRoot((dispose) => {
      let readQuota!: () => number;
      let writeQuota!: (next: number | ((p: number) => number)) => void;
      let readTab!: () => { tab?: string };
      let readMulti!: () => { mode: "light" | "dark" | "amber-night"; night: boolean };
      let writeMulti!: (patch: Partial<{ mode: "light" | "dark" | "amber-night"; night: boolean }>) => void;
      let loc!: ReturnType<typeof useLocation>;

      function MountedSkinsSubtree() {
        loc = useLocation();
        readTab = useRouteParams<{ tab?: string }>({ routeId: "skins" });
        [readQuota, writeQuota] = useSearchState(
          "quota",
          stateParam.int(72, { min: 10, max: 100 }),
          { routeId: "skins" },
        );
        [readMulti, writeMulti] = useSearchStates(
          {
            mode: stateParam.enum(["light", "dark", "amber-night"] as const, "light"),
            night: stateParam.boolean(true),
          },
          { routeId: "skins" },
        );
        return null;
      }

      let node: unknown = PocketRouterProvider({
        router,
        get children() {
          return PocketRouteScope({
            routeId: "skins",
            get children() {
              return MountedSkinsSubtree();
            },
          });
        },
      });
      while (typeof node === "function") {
        node = (node as () => unknown)();
      }
      expect(node).toBeNull();

      // Even though `router` is foreground, `skins` reads its own background stack entry!
      expect(loc().routeId).toBe("router");
      expect(readTab().tab).toBe("controls");
      expect(readQuota()).toBe(91);

      // Pop from `router` back to `skins`
      router.back();
      expect(loc().routeId).toBe("skins");

      // Mutate signal -> updates live URL query string
      writeQuota((q) => q + 4);
      expect(readQuota()).toBe(95);
      expect(router.uri()).toBe("pocket://showcase/skins/controls?quota=95");

      // Setting back to default 72 strips `quota` cleanly
      writeQuota(72);
      expect(router.uri()).toBe("pocket://showcase/skins/controls");

      writeMulti({ mode: "amber-night", night: false });
      expect(router.uri()).toBe("pocket://showcase/skins/controls?mode=amber-night&night=0");

      // Navigate to `/home` (resets stack to `["home"]`): `skins` preserves its last state during exit!
      router.navigate("/home");
      expect(router.current().routeId).toBe("home");
      expect(readTab().tab).toBe("controls");
      expect(readMulti().mode).toBe("amber-night");
      expect(readMulti().night).toBe(false);

      dispose();
    });
  });

  test("bindPlatformExperience consumes initial link and live stream events cleanly", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const bridge = createHostBridge((packet) => {
      sent.push(packet);
      return true;
    });
    const experience = createPlatformExperience(bridge);
    const router = createPocketRouter({
      routes: [
        { id: "home", path: "/home", primary: true },
        { id: "skins", path: "/skins/:tab?", parent: "home" },
      ],
    });

    expect(extractLinkUri({ uri: "pocket://showcase/skins/overlays?dialog=1" })).toBe(
      "pocket://showcase/skins/overlays?dialog=1",
    );

    const unbind = router.bindPlatformExperience(experience, {
      checkInitial: true,
      subscribe: false,
    });
    const req = sent.find(
      (p) => (p.payload as { capability?: string } | undefined)?.capability === "platform.links.initial",
    );
    expect(req).toBeDefined();
    const requestId = String((req!.payload as { requestId: string }).requestId);
    bridge.handle({
      type: "response",
      requestId,
      capability: "platform.links.initial",
      ok: true,
      result: { uri: "pocket://showcase/skins/overlays?dialog=1" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(router.current().routeId).toBe("skins");
    expect(router.params().tab).toBe("overlays");
    expect(router.stack().map((e) => e.routeId)).toEqual(["home", "skins"]);

    unbind();
    experience.dispose();
    bridge.dispose();
  });

  test("router.batch coalesces multiple search/navigation updates into a single onChange notification", () => {
    const events: Array<{ uri: string; reason: string }> = [];
    const router = createPocketRouter({
      routes: [
        { id: "home", path: "/home", primary: true },
        {
          id: "stress",
          path: "/stress",
          parent: "home",
          searchSchema: {
            preset: stateParam.enum(["balanced", "heavy", "extreme"] as const, "heavy"),
            particles: stateParam.int(224, { min: 32, max: 512 }),
            rows: stateParam.int(50_000, { min: 1_000, max: 100_000 }),
            mutations: stateParam.int(2_500, { min: 100, max: 10_000 }),
          },
        },
      ],
      onChange: (entry, _stack, reason) => {
        events.push({ uri: entry.uri, reason });
      },
    });

    router.navigate("/stress");
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("navigate");

    router.batch(() => {
      router.setSearch((prev) => ({ ...prev, preset: "extreme" }));
      router.setSearch((prev) => ({ ...prev, particles: 512 }));
      router.setSearch((prev) => ({ ...prev, rows: 100_000 }));
      router.setSearch((prev) => ({ ...prev, mutations: 8_000 }));
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      uri: "pocket://showcase/stress?mutations=8000&particles=512&preset=extreme&rows=100000",
      reason: "search",
    });

    router.navigate("/home");
    const countBefore = events.length;
    router.batch(() => {
      router.navigate("/stress");
      router.setSearch((prev) => ({ ...prev, particles: 384, preset: "extreme" }));
    });
    expect(events.length).toBe(countBefore + 1);
    expect(events[events.length - 1]).toEqual({
      uri: "pocket://showcase/stress?particles=384&preset=extreme",
      reason: "navigate",
    });
  });
});
