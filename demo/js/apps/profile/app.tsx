import { For, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { after, simulationHz } from "@pocketjs/framework/clock";
import { Text, View } from "@pocketjs/framework/solid/components";
import {
  PocketAppShell,
  ScrollablePage,
  SkinBadge,
  SkinButton,
  SkinCard,
  SkinParagraph,
  StatusBar,
  UiSkinProvider,
  createPocketRouter,
  defaultSkinAdapter,
  usePocketAppLifecycle,
  useUiSkin,
} from "@pocket/ui";
import { looseleafSkinAdapter } from "@pocket/looseleaf";
import { arcSkinAdapter } from "@pocket/arc";
import { liquidGlassSkinAdapter } from "@pocket/liquid_glass";
import { createHostBridge, type JsonValue } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";

const LOBBY_APP_ID = "pocket.demo.lobby";
const SHARED_NAMESPACE = "identity";

type ProfileKey = "alex" | "lin";
type Profile = {
  name: string;
  role: string;
  uid: string;
  vipLevel: number;
};

const PROFILES: Record<ProfileKey, Profile> = {
  alex: {
    name: "Alex Chen",
    role: "Chief Sandbox Architect",
    uid: "USR-ALEX-1001",
    vipLevel: 9,
  },
  lin: {
    name: "Lin Mei",
    role: "Lead 3D Flutter Scene Engineer",
    uid: "USR-LIN-1007",
    vipLevel: 7,
  },
};

type StoredProfile = Partial<Profile> & { name?: unknown; role?: unknown; uid?: unknown };

function profileFromValue(value: unknown): Profile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as StoredProfile;
  if (typeof candidate.name !== "string" || typeof candidate.role !== "string" || typeof candidate.uid !== "string") {
    return undefined;
  }
  return {
    name: candidate.name,
    role: candidate.role,
    uid: candidate.uid,
    vipLevel: typeof candidate.vipLevel === "number" ? candidate.vipLevel : 0,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ProfileSummary(props: { profile: () => Profile }): JSX.Element {
  const { tokens } = useUiSkin();
  return (
    <View class="flex-col gap-1">
      <SkinParagraph text="Current selection" muted />
      <Text class="text-lg font-bold" style={{ textColor: tokens().ink }}>{props.profile().name}</Text>
      <SkinParagraph text={props.profile().role} muted />
      <SkinParagraph text={`UID ${props.profile().uid} · VIP ${props.profile().vipLevel}`} muted />
    </View>
  );
}

function ProfilePage(props: {
  selected: () => ProfileKey;
  stored: () => Profile | undefined;
  busy: () => boolean;
  status: () => string;
  statusOk: () => boolean;
  selectedProfile: () => Profile;
  onChooseProfile: (key: ProfileKey) => void;
  onSaveAndOpenLobby: () => void;
  onReturnToShowcase: () => void;
  onRefreshIdentity: () => void;
}): JSX.Element {
  usePocketAppLifecycle({
    onResume: () => {
      props.onRefreshIdentity();
    },
  });

  return (
    <ScrollablePage>
      <View class="flex-col gap-3 p-4">
        <StatusBar label="Identity namespace" detail={props.status()} ok={props.statusOk()} />
        <SkinCard
          title="PocketNexus identity"
          detail="A real JS-owned profile guest. The saved value is shared only through the host allowlist."
        >
          <ProfileSummary profile={props.selectedProfile} />
        </SkinCard>
        <SkinCard title="Choose an account" detail="Select the identity to share with Lobby.">
          <View class="flex-col gap-2">
            <For each={Object.entries(PROFILES) as [ProfileKey, Profile][]}>
              {([key, profile]) => (
                <SkinButton
                  label={`${profile.name} (VIP ${profile.vipLevel})`}
                  variant={props.selected() === key ? "primary" : "outline"}
                  disabled={props.busy()}
                  onPress={() => props.onChooseProfile(key)}
                />
              )}
            </For>
          </View>
        </SkinCard>
        <SkinCard
          title="Host-backed flow"
          detail={props.stored() ? `Last shared value: ${props.stored()!.name} · ${props.stored()!.uid}` : "No identity has been saved in this session."}
        >
          <View class="flex-col gap-2">
            <SkinButton
              label="Save identity & open Lobby"
              disabled={props.busy()}
              onPress={props.onSaveAndOpenLobby}
            />
            <SkinButton
              label="Return to Showcase"
              variant="outline"
              disabled={props.busy()}
              onPress={props.onReturnToShowcase}
            />
          </View>
        </SkinCard>
      </View>
    </ScrollablePage>
  );
}

function ProfileApp(): JSX.Element {
  const host = createHostBridge(undefined, {
    timeoutFrames: 30 * simulationHz(),
    scheduleTimeout: (frames, cb) => after(frames / simulationHz(), cb),
  });
  const platform = createPocketPlatformClient(undefined, { bridge: host, media: false });
  const router = createPocketRouter({
    routes: [{ id: "home", path: "/", primary: true }],
    fallbackRouteId: "home",
  });
  const [selected, setSelected] = createSignal<ProfileKey>("alex");
  const [stored, setStored] = createSignal<Profile | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("Choose Alex or Lin, then open the lobby.");
  const [statusOk, setStatusOk] = createSignal(true);

  const refreshSharedIdentity = async (initial = false): Promise<void> => {
    try {
      const value = await platform.storage.get("userInfo", SHARED_NAMESPACE);
      const profile = profileFromValue(value);
      if (profile) {
        const match = (Object.keys(PROFILES) as ProfileKey[]).find((key) => PROFILES[key].uid === profile.uid);
        if (match) setSelected(match);
        setStored(match ? PROFILES[match] : profile);
        if (initial) {
          setStatus(`Shared identity restored for ${profile.name}.`);
        }
      }
    } catch (error) {
      if (initial) {
        setStatus(`Shared identity unavailable: ${errorText(error)}`);
        setStatusOk(false);
      }
    }
  };

  onMount(() => {
    void refreshSharedIdentity(true);
  });

  onCleanup(() => {
    platform.dispose();
    host.dispose();
  });

  const selectedProfile = (): Profile => PROFILES[selected()];

  const chooseProfile = (key: ProfileKey): void => {
    setSelected(key);
    setStatus(`Selected ${PROFILES[key].name}. Save it to the identity namespace.`);
    setStatusOk(true);
  };

  const returnToShowcase = async (value: JsonValue): Promise<void> => {
    try {
      await platform.returnResult(value);
    } catch (error) {
      setStatus(`Return failed: ${errorText(error)}`);
      setStatusOk(false);
    }
  };

  const saveAndOpenLobby = async (): Promise<void> => {
    setBusy(true);
    setStatusOk(true);
    const profile = selectedProfile();
    const userInfo = {
      name: profile.name,
      role: profile.role,
      uid: profile.uid,
    };
    try {
      await platform.storage.set("userInfo", userInfo, SHARED_NAMESPACE);
      setStored(profile);
      setStatus(`Saved ${profile.name}; opening the independent lobby guest...`);
      const result = await platform.openApp(LOBBY_APP_ID, {
        from: "profile",
        userInfo,
      });
      const returned = result.value && typeof result.value === "object"
        ? JSON.stringify(result.value)
        : String(result.value ?? "no result");
      const outcome = result.cancelled
        ? `Lobby cancelled${result.reason ? ` (${result.reason})` : ""}`
        : `Lobby returned: ${returned}`;
      // Returning/cancelling the nested lobby only resumes this Profile guest.
      // Keep selected/stored local state alive until the user explicitly
      // chooses the separate Return to Showcase action below.
      setStatus(`${outcome}; Profile remains available.`);
    } catch (error) {
      setStatus(`Profile flow failed: ${errorText(error)}`);
      setStatusOk(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <UiSkinProvider
      skins={[
        defaultSkinAdapter,
        looseleafSkinAdapter,
        arcSkinAdapter,
        liquidGlassSkinAdapter,
      ]}
    >
      <PocketAppShell
        router={router}
        host={host}
        platform={platform}
        reservedActions="mini-app"
        onRootBack={async () => {
          await returnToShowcase({
            profile: (stored() ?? selectedProfile()) as unknown as JsonValue,
            source: "profile",
            back: true,
          });
          return true;
        }}
        routes={[
          {
            id: "home",
            title: "Pocket Profile",
            subtitle: "pocket.demo.profile · shared identity",
            trailing: () => <SkinBadge label="Guest A" tone="accent" />,
            render: () => (
              <ProfilePage
                selected={selected}
                stored={stored}
                busy={busy}
                status={status}
                statusOk={statusOk}
                selectedProfile={selectedProfile}
                onChooseProfile={chooseProfile}
                onSaveAndOpenLobby={() => {
                  void saveAndOpenLobby();
                }}
                onReturnToShowcase={() => {
                  void returnToShowcase({
                    profile: (stored() ?? selectedProfile()) as unknown as JsonValue,
                    source: "profile",
                  });
                }}
                onRefreshIdentity={() => {
                  void refreshSharedIdentity(false);
                }}
              />
            ),
          },
        ]}
      />
    </UiSkinProvider>
  );
}

mount(() => <ProfileApp />);
