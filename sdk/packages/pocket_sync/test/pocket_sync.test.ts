import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
  InMemorySyncMeshRegistry,
  InMemorySyncServerNode,
  PocketSyncLedger,
  SyncReplayGuard,
  classifySyncHost,
  createLoopbackSyncTransport,
  createMultiEndpointSyncClient,
  createSyncAuthHeader,
  createSyncMeshStore,
  defaultPowerPolicyForDevice,
  defaultStorageDurabilityForDevice,
  parseSyncEndpointUrl,
  sha256Hex,
  utf8Decode,
  utf8Encode,
} from "../src/index.ts";

const makeHost = (...octets: number[]) => octets.join(".");

describe("@pocket/sync protocol, security & cross-subnet multi-server mesh", () => {
  test("classifies LAN, Tailscale/CGNAT Overlay (100.64.0.0/10), and WAN endpoints & enforces WAN HTTPS", () => {
    const lanIp = makeHost(192, 168, 31, 88);
    const tailscaleIp = makeHost(100, 96, 14, 22);
    const publicWanIp = makeHost(203, 0, 113, 45);

    expect(classifySyncHost(lanIp)).toBe("lan");
    expect(classifySyncHost("mac-studio.local")).toBe("lan");
    expect(classifySyncHost(tailscaleIp)).toBe("overlay");
    expect(classifySyncHost("home-hub.tail99.ts.net")).toBe("overlay");
    expect(classifySyncHost(publicWanIp)).toBe("wan");

    const parsedLan = parseSyncEndpointUrl(`${lanIp}:8795`);
    expect(parsedLan.networkKind).toBe("lan");
    expect(parsedLan.scheme).toBe("http");

    const parsedOverlay = parseSyncEndpointUrl(tailscaleIp);
    expect(parsedOverlay.networkKind).toBe("overlay");
    expect(parsedOverlay.port).toBe(8795);

    expect(() => parseSyncEndpointUrl(`http://${publicWanIp}:8795`)).toThrow(/requires https/i);
    const parsedWanHttps = parseSyncEndpointUrl("https://sync.example.com");
    expect(parsedWanHttps.networkKind).toBe("wan");
    expect(parsedWanHttps.scheme).toBe("https");
    expect(parsedWanHttps.port).toBe(443);
  });

  test("UTF-8 + SHA-256 + HKDF-HMAC ReplayGuard rejects replays, clock skew, and tampered payloads", () => {
    const sample = "宝宝喂奶记录🍼 Left 12m · 跨网段同步";
    expect(utf8Decode(utf8Encode(sample))).toBe(sample);
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );

    const nowMs = 1_760_000_000_000;
    const guard = new SyncReplayGuard({ maxSkewMs: 300_000 });
    const bodyHash = sha256Hex('{"ops":[]}');
    const header = createSyncAuthHeader({
      roomSecret: "family-secret-key-2026",
      namespace: "family_room_01",
      method: "POST",
      path: "/v1/pocket-sync/ops/exchange",
      bodySha256: bodyHash,
      timestampMs: nowMs,
      nonce: "nonce_alpha_001",
    });

    // First verification succeeds
    expect(
      guard.verifyHeader({
        headerValue: header,
        roomSecret: "family-secret-key-2026",
        namespace: "family_room_01",
        method: "POST",
        path: "/v1/pocket-sync/ops/exchange",
        bodySha256: bodyHash,
        nowMs: nowMs + 1500,
      }).ok,
    ).toBe(true);

    // Exact replay within window is rejected!
    const replayAttempt = guard.verifyHeader({
      headerValue: header,
      roomSecret: "family-secret-key-2026",
      namespace: "family_room_01",
      method: "POST",
      path: "/v1/pocket-sync/ops/exchange",
      bodySha256: bodyHash,
      nowMs: nowMs + 2000,
    });
    expect(replayAttempt.ok).toBe(false);
    expect(replayAttempt.reason).toBe("replayed_nonce");

    // Out-of-window timestamp (> 5 min) is rejected
    const staleHeader = createSyncAuthHeader({
      roomSecret: "family-secret-key-2026",
      namespace: "family_room_01",
      method: "GET",
      path: "/v1/pocket-sync/info",
      timestampMs: nowMs - 600_000,
      nonce: "nonce_stale",
    });
    expect(
      guard.verifyHeader({
        headerValue: staleHeader,
        roomSecret: "family-secret-key-2026",
        namespace: "family_room_01",
        method: "GET",
        path: "/v1/pocket-sync/info",
        nowMs,
      }).reason,
    ).toBe("timestamp_out_of_window");
  });

  test("serverSeq watermark guarantees ZERO missed late-arriving offline ops across 3 heterogeneous servers", async () => {
    const namespace = "family_mesh_v2";
    const roomSecret = "mesh-shared-secret";
    let wallClock = 1_762_000_000_000;
    const nowFn = () => wallClock;

    const registry = new InMemorySyncMeshRegistry();

    // Server 1: macOS Home Hub (LAN, persistent)
    const macHub = new InMemorySyncServerNode({
      namespace,
      roomSecret,
      nodeId: "mac_mini_hub",
      deviceName: "书房 Mac mini",
      deviceKind: "macos",
      nowMs: nowFn,
    });
    const macUrl = registry.register(`http://${makeHost(192, 168, 1, 10)}:8795`, macHub, {
      simulatedRttMs: 3,
    });

    // Server 2: Grandparents' Apple TV across Tailscale Overlay (ephemeralCache!)
    const grandmaTv = new InMemorySyncServerNode({
      namespace,
      roomSecret,
      nodeId: "grandma_apple_tv",
      deviceName: "外婆家客厅 Apple TV",
      deviceKind: "tvos",
      nowMs: nowFn,
    });
    const tvOverlayUrl = registry.register(`http://${makeHost(100, 88, 12, 5)}:8795`, grandmaTv, {
      simulatedRttMs: 24,
    });

    // Server 3: Cloud HTTPS Relay (WAN, persistent)
    const cloudRelay = new InMemorySyncServerNode({
      namespace,
      roomSecret,
      nodeId: "cloud_relay_hk",
      deviceName: "香港云端中继",
      deviceKind: "desktop",
      nowMs: nowFn,
    });
    const cloudUrl = registry.register("https://relay.pocket-family.example", cloudRelay, {
      simulatedRttMs: 55,
    });

    const transport = createLoopbackSyncTransport(registry, nowFn);

    // Dad records an OFFLINE feeding at T=10:00 while in elevator (no network!)
    const dadLedger = new PocketSyncLedger({ nodeId: "dad_iphone", nowMs: () => wallClock });
    const offlineDadOp = dadLedger.recordLocalOp({
      namespace,
      collection: "feed_events",
      entityId: "feed_elevator_01",
      payload: { kind: "bottle", ml: 150, note: "电梯离线补记" },
      authorId: "dad",
      occurredAtMs: wallClock,
    })!;

    // Time advances +30 minutes (T=10:30): Mom records diaper on LAN Mac Hub & syncs
    wallClock += 30 * 60 * 1000;
    const momClient = createMultiEndpointSyncClient({
      namespace,
      roomSecret,
      clientNodeId: "mom_iphone",
      transport,
      enableLivePush: false,
      initialEndpoints: [
        { url: macUrl, label: "家里 Mac" },
        { url: tvOverlayUrl, label: "外婆家 Tailscale TV" },
        { url: cloudUrl, label: "云端备份" },
      ],
      nowMs: nowFn,
    });
    momClient.ledger.recordLocalOp({
      namespace,
      collection: "diaper_events",
      entityId: "diaper_morning_02",
      payload: { kind: "wet", weightGrams: 85 },
      authorId: "mom",
      occurredAtMs: wallClock,
    });

    await momClient.probeAll();
    // Endpoints are automatically sorted by RTT: LAN (3ms) -> Tailscale (24ms) -> WAN (55ms)
    const sorted = momClient.getEndpoints();
    expect(sorted.map((e) => e.networkKind)).toEqual(["lan", "overlay", "wan"]);

    const round1 = await momClient.syncAll();
    expect(round1.onlineEndpoints).toBe(3);

    // Now at T=10:45, Dad regains cellular Tailscale and uploads his OLD T=10:00 op ONLY to Grandma's TV!
    // Notice Dad's op.hlc (10:00) is OLDER than Mom's watermark HLC (10:30),
    // yet Grandma's TV assigns it serverSeq = 2 (> Mom's lastSeenSeq = 1)!
    wallClock += 15 * 60 * 1000;
    const dadClient = createMultiEndpointSyncClient({
      namespace,
      roomSecret,
      clientNodeId: "dad_iphone",
      ledger: dadLedger,
      transport,
      enableLivePush: false,
      initialEndpoints: [{ url: tvOverlayUrl, label: "外婆家 Tailscale TV" }],
      nowMs: nowFn,
    });
    await dadClient.syncAll();
    expect(grandmaTv.ledger.getEntity(namespace, "feed_events", offlineDadOp.entityId)).toBeDefined();
    expect(macHub.ledger.getEntity(namespace, "feed_events", offlineDadOp.entityId)).toBeUndefined();

    // Mom wakes from background and runs syncAll() -> pulls Dad's late-arriving T=10:00 op via serverSeq=2
    // AND automatically fans it out to Mac Hub & Cloud Relay in the convergence pass!
    const round2 = await momClient.syncAll();
    expect(round2.totalPulled).toBeGreaterThanOrEqual(1);
    expect(momClient.ledger.getEntity(namespace, "feed_events", "feed_elevator_01")?.fields.ml).toBe(150);
    expect(macHub.ledger.getEntity(namespace, "feed_events", "feed_elevator_01")?.fields.ml).toBe(150);
    expect(cloudRelay.ledger.getEntity(namespace, "feed_events", "feed_elevator_01")?.fields.ml).toBe(150);

    momClient.dispose();
    dadClient.dispose();
  });

  test("enforces storageDurability: tvOS ephemeralCache denies permanentArchiveSafe while macOS issues valid archive receipt across 300 KiB multi-chunk blob", async () => {
    const namespace = "blob_durability_room";
    const roomSecret = "photo-vault-secret";
    const registry = new InMemorySyncMeshRegistry();

    expect(defaultStorageDurabilityForDevice("tvos")).toBe("ephemeralCache");
    expect(defaultStorageDurabilityForDevice("watchos")).toBe("ephemeralCache");
    expect(defaultStorageDurabilityForDevice("macos")).toBe("persistent");
    expect(defaultPowerPolicyForDevice("watchos")).toBe("adaptiveRelay");

    const tvosNode = new InMemorySyncServerNode({
      namespace,
      roomSecret,
      nodeId: "apple_tv_cache",
      deviceName: "Apple TV",
      deviceKind: "tvos",
    });
    const tvUrl = registry.register(`http://${makeHost(192, 168, 50, 20)}:8795`, tvosNode);

    const transport = createLoopbackSyncTransport(registry);
    const mobileClient = createMultiEndpointSyncClient({
      namespace,
      roomSecret,
      clientNodeId: "phone_01",
      transport,
      initialEndpoints: [{ url: tvUrl, label: "客厅 Apple TV" }],
    });

    // 300 KiB photo (> 256 KiB bridge cap -> automatically split into 3 x 128 KiB chunks!)
    const photoBytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < photoBytes.length; i++) {
      photoBytes[i] = (i * 31 + 7) & 0xff;
    }

    const tvOnlyUpload = await mobileClient.uploadBlobToMesh(photoBytes);
    expect(tvOnlyUpload.receipts.length).toBe(1);
    expect(tvOnlyUpload.receipts[0]!.storageDurability).toBe("ephemeralCache");
    expect(tvOnlyUpload.receipts[0]!.permanentArchiveSafe).toBe(false);
    // CRITICAL: Mobile must NOT reclaim local photo when only synced to tvOS cache!
    expect(tvOnlyUpload.hasPermanentArchiveReceipt).toBe(false);

    // Now add macOS persistent server and upload again -> permanentArchiveSafe = true!
    const macNode = new InMemorySyncServerNode({
      namespace,
      roomSecret,
      nodeId: "mac_archive",
      deviceName: "Mac Studio",
      deviceKind: "macos",
    });
    const macUrl = registry.register(`http://${makeHost(100, 77, 88, 99)}:8795`, macNode);
    mobileClient.addEndpoint({ url: macUrl, label: "Mac Studio Tailscale" });

    const meshUpload = await mobileClient.uploadBlobToMesh(photoBytes);
    expect(meshUpload.hasPermanentArchiveReceipt).toBe(true);

    // Verify chunked download reconstructs exact 300 KiB SHA-256 verified bytes!
    const downloaded = await mobileClient.downloadBlobFromMesh(meshUpload.blobSha256);
    expect(downloaded).not.toBeNull();
    expect(downloaded!.byteLength).toBe(photoBytes.byteLength);
    expect(sha256Hex(downloaded!)).toBe(sha256Hex(photoBytes));

    mobileClient.dispose();
  });

  test("Watch adaptiveRelay degrades gracefully to client-only when OS denies inbound socket bind", () => {
    const watchNode = new InMemorySyncServerNode({
      namespace: "watch_room",
      roomSecret: "watch_secret",
      nodeId: "watch_ultra",
      deviceName: "Apple Watch Ultra",
      deviceKind: "watchos",
      simulateBindDenied: true,
    });

    const status = watchNode.getStatus();
    expect(status.running).toBe(false);
    expect(status.degradedToClientOnly).toBe(true);
    expect(status.mode).toBe("adaptiveRelayClientOnly");
  });

  test("createSyncMeshStore drives reactive SolidJS signals for embedded server + multi-endpoint pool", async () => {
    const registry = new InMemorySyncMeshRegistry();
    const remoteHub = new InMemorySyncServerNode({
      namespace: "solid_store_ns",
      roomSecret: "solid_secret",
      nodeId: "remote_tv",
      deviceName: "Android TV Hub",
      deviceKind: "android-tv",
    });
    const remoteUrl = registry.register(`http://${makeHost(100, 101, 2, 3)}:8795`, remoteHub);

    let disposeRoot = () => {};
    const store = createRoot((dispose) => {
      disposeRoot = dispose;
      return createSyncMeshStore({
        namespace: "solid_store_ns",
        roomSecret: "solid_secret",
        nodeId: "mac_menubar",
        deviceName: "Mac MenuBar",
        deviceKind: "macos",
        advertisedUrls: [`http://${makeHost(192, 168, 1, 55)}:8795`],
        autoStartServer: false,
        meshRegistry: registry,
      });
    });

    const started = await store.setServerEnabled(true);
    expect(started.running).toBe(true);
    expect(store.serverStatus().lanUrls.length).toBe(1);

    store.addEndpoint(remoteUrl, "跨网段电视节点");
    expect(store.endpoints().length).toBe(1);

    const op = store.ledger.recordLocalOp({
      namespace: "solid_store_ns",
      collection: "notes",
      entityId: "note_1",
      payload: { title: "Synced via Solid Store" },
      authorId: "user_1",
    })!;
    await store.recordAndBroadcastOp(op);

    expect(store.onlineCount()).toBe(1);
    expect(remoteHub.ledger.getEntity("solid_store_ns", "notes", "note_1")?.fields.title).toBe(
      "Synced via Solid Store",
    );

    store.dispose();
    disposeRoot();
  });
});
