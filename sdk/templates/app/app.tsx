import { For, createSignal } from "solid-js";
import {
  PocketAppShell,
  ScrollablePage,
  SkinButton,
  SkinCard,
  SkinDialog,
  SkinInput,
  SkinListTile,
  SkinParagraph,
  SkinSwitch,
  UiSkinProvider,
  createPocketRouter,
  type NavigationItem,
  type PocketRouteDefinition,
} from "@pocket/ui";
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";

type Route = "home" | "detail" | "settings";

interface State {
  readonly dark: boolean;
  readonly draft: string;
  readonly notes: readonly string[];
  readonly helpOpen: boolean;
}

type Action =
  | { readonly type: "toggleTheme" }
  | { readonly type: "setDraft"; readonly value: string }
  | { readonly type: "addNote" }
  | { readonly type: "setHelpOpen"; readonly open: boolean };

const initialState: State = {
  dark: false,
  draft: "",
  notes: [
    "编辑 app.tsx，然后运行 pocket build。",
    "所有路由、安全区与导航优先复用 @pocket/ui。",
  ],
  helpOpen: false,
};

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "toggleTheme":
      return { ...state, dark: !state.dark };
    case "setDraft":
      return { ...state, draft: action.value };
    case "addNote": {
      const trimmed = state.draft.trim();
      if (!trimmed) return state;
      return {
        ...state,
        draft: "",
        notes: [trimmed, ...state.notes],
      };
    }
    case "setHelpOpen":
      return { ...state, helpOpen: action.open };
  }
}

const ROUTES: readonly PocketRouteDefinition<Route>[] = [
  { id: "home", path: "/home", aliases: ["/"], primary: true },
  { id: "detail", path: "/detail", parent: "home" },
  { id: "settings", path: "/settings", primary: true },
];

const TABS: readonly NavigationItem[] = [
  { id: "home", label: "首页", kind: "home" },
  { id: "settings", label: "设置", kind: "settings" },
];

function App() {
  const [state, setState] = createSignal<State>(initialState);
  const dispatch = (action: Action): void => {
    setState((current) => reduce(current, action));
  };

  const router = createPocketRouter<Route>({
    routes: ROUTES,
    fallbackRouteId: "home",
  });

  return (
    <UiSkinProvider mode={() => (state().dark ? "dark" : "light")}>
      <PocketAppShell
        router={router}
        tabs={TABS}
        trailing={() => (
          <SkinButton
            label={state().dark ? "浅色" : "深色"}
            variant="ghost"
            compact
            onPress={() => dispatch({ type: "toggleTheme" })}
          />
        )}
        routes={[
          {
            id: "home",
            title: "Pocket 应用",
            subtitle: "应用模板",
            render: () => (
              <ScrollablePage class="px-4 py-4 gap-3">
                <View class="flex-col gap-1">
                  <SkinParagraph text="你好，PocketJS" class="text-xl font-bold" />
                  <SkinParagraph
                    text="使用 createPocketRouter + PocketAppShell + @pocket/ui 构建页面与导航"
                    muted
                    class="text-sm"
                  />
                </View>
                <SkinCard title="待办清单">
                  <For each={state().notes}>
                    {(note, idx) => (
                      <SkinListTile
                        title={note}
                        detail={`记录 #${idx() + 1}`}
                      />
                    )}
                  </For>
                  <SkinButton
                    label="新建记录"
                    onPress={() => router.push("detail")}
                  />
                </SkinCard>
              </ScrollablePage>
            ),
          },
          {
            id: "detail",
            title: "新建记录",
            render: () => (
              <ScrollablePage class="px-4 py-4 gap-3">
                <SkinCard title="新建记录">
                  <SkinInput
                    value={() => state().draft}
                    placeholder="输入事项标题"
                    onInput={(value) => dispatch({ type: "setDraft", value })}
                  />
                  <SkinButton
                    label="保存并返回"
                    disabled={!state().draft.trim()}
                    onPress={() => {
                      if (!state().draft.trim()) return;
                      dispatch({ type: "addNote" });
                      router.back();
                    }}
                  />
                </SkinCard>
              </ScrollablePage>
            ),
          },
          {
            id: "settings",
            title: "设置",
            render: () => (
              <ScrollablePage class="px-4 py-4 gap-3">
                <SkinCard title="外观与框架">
                  <SkinSwitch
                    label="深色模式"
                    detail="通过 UiSkinProvider 统一切换内置组件主题"
                    value={state().dark}
                    onChange={() => dispatch({ type: "toggleTheme" })}
                  />
                  <SkinButton
                    label="规则说明"
                    onPress={() => dispatch({ type: "setHelpOpen", open: true })}
                  />
                </SkinCard>
                <SkinDialog
                  open={state().helpOpen}
                  title="框架优先约束"
                  body="弹窗打开时按返回键会自动关闭弹窗，不会误退底层路由。"
                  onClose={() => dispatch({ type: "setHelpOpen", open: false })}
                />
              </ScrollablePage>
            ),
          },
        ]}
      />
    </UiSkinProvider>
  );
}

mount(() => <App />);
