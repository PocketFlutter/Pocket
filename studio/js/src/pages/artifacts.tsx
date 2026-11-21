import { For, Show, createSignal, onMount } from "solid-js";
import { MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "../components/info.tsx";
import { formatBytes, formatTime, shortHash } from "../lib/format.ts";
import type { Studio } from "../state/studio.ts";
import { HairlineH, HairlineV, StateChip, StudioButton } from "../components/workbench-ui.tsx";

const MAX_RAW_LINES = 400;

/** Reusable Artifacts Inspector Pane embedded inside `.console-dock` (Tab 3) and `ArtifactsPage`. */
export function ArtifactsPane(props: { studio: Studio }) {
  const s = props.studio;
  const a = fromStore(s.artifacts.store);
  const project = () => s.projects.current();
  onMount(() => { if (project() && !a().loaded && !a().loading) void s.artifacts.refresh(); });
  const copy = (text: string, what: string) => { void s.copy(text, what); };
  const rawLines = () => (a().selected?.text ?? "").split("\n");
  const [section, setSection] = createSignal<"bytecode" | "manifest" | "pack" | "build">("bytecode");

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: C.bgRaised, minH: 0 }}>
      {/* Header Bar */}
      <View class="flex-row items-center justify-between gap-2 px-3 py-1.5 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center gap-2 flex-wrap">
          <Text class="text-sm font-bold" style={{ textColor: C.text }}>{`产物 · ${project() ?? "请选择项目"}`}</Text>
          <Show when={a().loaded && a().built}>
            <StateChip
              label={a().builtRevision === a().revision ? `当前构建 r${a().builtRevision}` : `构建 r${a().builtRevision} · 源码已更改到 r${a().revision}`}
              tone={a().builtRevision === a().revision ? "good" : "warn"}
            />
          </Show>
          <Show when={a().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取产物…</Text></Show>
          <Show when={a().error}><Text class="text-xs" style={{ textColor: C.danger }}>{`读取失败：${a().error}`}</Text></Show>
        </View>
        <StudioButton label="刷新" kind="secondary" size="xs" disabled={!project()} onPress={() => void s.artifacts.refresh()} />
      </View>
      <HairlineH />

      <Show when={project() === undefined}>
        <View class="p-3"><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></View>
      </Show>
      <Show when={a().loaded && !a().built && !a().error}>
        <View class="p-3"><Text class="text-xs" style={{ textColor: C.muted }}>完成一次成功的构建后，产物会显示在这里。</Text></View>
      </Show>

      <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
        {/* Left Artifact File List */}
        <View class="flex-col p-2 h-full" style={{ width: 256, bgColor: C.bgRaised, shrink: 0 }}>
          <ScrollablePage>
            <View class="flex-col gap-1 w-full">
              <For each={a().files}>
                {(f) => {
                  const selected = () => a().selected?.name === f.name;
                  return (
                    <Focusable
                      class="flex-col gap-0.5 px-2.5 py-2 rounded-lg w-full"
                      style={{
                        bgColor: selected() ? C.primarySoft : C.surface,
                        borderColor: selected() ? C.primaryBorder : C.line,
                        borderWidth: 1,
                        radius: 7,
                      }}
                      onPress={() => void s.artifacts.select(f.name)}
                    >
                      <Text class="text-xs font-mono font-bold" style={{ textColor: C.text }}>{f.label}</Text>
                      <Text class="text-2xs" style={{ textColor: C.muted }}>
                        {`${f.role}${f.bytes !== undefined ? ` · ${formatBytes(f.bytes)}` : f.lazy ? " · 点击查看" : f.available ? "" : " · 不可用"}`}
                      </Text>
                    </Focusable>
                  );
                }}
              </For>
            </View>
          </ScrollablePage>
        </View>
        <HairlineV />

        {/* Right Detail / Overview */}
        <View class="flex-col p-2.5 flex-1 h-full" style={{ minW: 0, minH: 0 }}>
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Show
                when={a().selected}
                fallback={
                  <>
                    <Show when={a().built}>
                      <MobileSegmentedControl
                        items={[
                          { id: "bytecode", label: "字节码" },
                          { id: "manifest", label: "来宾清单" },
                          { id: "pack", label: "包内容" },
                          { id: "build", label: "构建信息" },
                        ]}
                        active={section()}
                        onChange={(id) => setSection(id as "bytecode" | "manifest" | "pack" | "build")}
                      />
                    </Show>
                    <Show when={section() === "bytecode" && a().bytecode}>
                      {(b) => (
                        <Panel title="字节码" eyebrow="BYTECODE" note="来自 app.bytecode.json">
                          <Field label="运行时 ABI" value={b().runtimeAbi} shown={b().runtimeAbi ? shortHash(b().runtimeAbi!, 26, 8) : undefined} onCopy={copy} />
                          <Line label="绑定代数" value={b().bindingGeneration} />
                          <Line label="入口格式" value={b().entryFormat} />
                          <Line label="帧率 (tickHz)" value={b().tickHz} />
                          <Line label="字节码大小" value={b().bytecodeBytes !== undefined ? formatBytes(b().bytecodeBytes!) : undefined} />
                          <Field label="payload SHA-256" value={b().payloadSha256} shown={b().payloadSha256 ? shortHash(b().payloadSha256!, 20, 8) : undefined} onCopy={copy} />
                          <Field label="源码 SHA-256" value={b().sourceSha256} shown={b().sourceSha256 ? shortHash(b().sourceSha256!, 20, 8) : undefined} onCopy={copy} />
                          <Field label="引擎 ABI" value={b().engineAbi} shown={b().engineAbi ? shortHash(b().engineAbi!, 20, 8) : undefined} onCopy={copy} />
                          <Line label="版本" value={b().version !== undefined ? `v${b().version}${b().build !== undefined ? ` · 构建 ${b().build}` : ""}` : undefined} />
                        </Panel>
                      )}
                    </Show>
                    <Show when={section() === "manifest" && a().manifest}>
                      {(m) => (
                        <Panel title="来宾清单" eyebrow="MANIFEST" note="来自 guest-manifest.json">
                          <Line label="协议版本" value={m().protocolVersion} />
                          <Line label="必需能力" value={m().requires.length ? m().requires.join("、") : "无"} />
                          <Line label="可选能力" value={`${m().optional.length} 项`} />
                          <Line label="必需权限" value={m().permissionsRequired.length ? m().permissionsRequired.join("、") : "无"} />
                          <Line label="可选权限" value={m().permissionsOptional.length ? m().permissionsOptional.join("、") : "无"} />
                          <Line
                            label="内存"
                            value={
                              m().memory
                                ? [
                                    m().memory!.heapLimitBytes !== undefined ? `堆上限 ${formatBytes(m().memory!.heapLimitBytes!)}` : "",
                                    m().memory!.maxPakBytes !== undefined ? `资源包上限 ${formatBytes(m().memory!.maxPakBytes!)}` : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")
                                : m().memoryPolicy
                                  ? `策略 ${m().memoryPolicy}`
                                  : "默认"
                            }
                          />
                        </Panel>
                      )}
                    </Show>
                    <Show when={section() === "pack" && a().built}>
                      <Panel title="包内容" eyebrow="PAK INVENTORY" note="按资源快照 (resources.json) 汇总；.pak 本身只提供大小，不在 Studio 内展开。">
                        <Show when={a().packNote}><Text class="text-xs" style={{ textColor: C.warn }}>{a().packNote}</Text></Show>
                        <For each={a().packages}>
                          {(p) => (
                            <View class="flex-col gap-0.5 p-2 rounded-md w-full" style={{ bgColor: C.surface, borderColor: C.line, borderWidth: 1, radius: 6 }}>
                              <Text class="text-xs font-bold" style={{ textColor: C.text }}>{`${p.title ?? p.id} · ${p.id}${p.version ? ` · v${p.version}` : ""}`}</Text>
                              <Text class="text-xs" style={{ textColor: C.muted }}>{`共 ${p.total} 项 · ${formatBytes(p.totalBytes)}（其中图片/资产 ${p.assets} 项）`}</Text>
                              <Text class="text-xs" style={{ textColor: C.muted }}>{`随包 ${p.inPak} 项 · ${formatBytes(p.inPakBytes)} ｜ 网络下载 ${p.network} 项 · ${formatBytes(p.networkBytes)}`}</Text>
                            </View>
                          )}
                        </For>
                      </Panel>
                    </Show>
                    <Show when={section() === "build" && a().buildInfo}>
                      {(b) => (
                        <Panel title="构建信息" eyebrow="BUILD" note="来自 build.json">
                          <Line label="应用" value={b().appId} />
                          <Line label="版本" value={b().version !== undefined ? `v${b().version}${b().build !== undefined ? ` · 构建 ${b().build}` : ""}` : undefined} />
                          <Line label="修订" value={b().revision !== undefined ? `r${b().revision}` : undefined} />
                          <Line label="生成时间" value={formatTime(b().generatedAt)} />
                          <Field label="构建代 (generation)" value={b().generation} onCopy={copy} />
                          <Line label="包" value={b().packages.length ? b().packages.map((p) => `${p.id}${p.version ? ` v${p.version}` : ""}`).join("、") : undefined} />
                        </Panel>
                      )}
                    </Show>
                  </>
                }
              >
                {(sel) => (
                  <Panel
                    title={sel().name}
                    eyebrow="RAW ARTIFACT"
                    right={<StudioButton label="返回概览" kind="secondary" size="xs" onPress={() => s.artifacts.closeSelected()} />}
                  >
                    <Show when={sel().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取…</Text></Show>
                    <Show when={sel().error}><Text class="text-xs" style={{ textColor: C.danger }}>{sel().error}</Text></Show>
                    <Show when={sel().bytes !== undefined}><Text class="text-xs" style={{ textColor: C.muted }}>{`大小 ${formatBytes(sel().bytes!)}`}</Text></Show>
                    <Show when={!sel().loading && !sel().error && sel().text === undefined}>
                      <Text class="text-xs" style={{ textColor: C.warn }}>二进制产物只显示元数据：其中嵌有调试路径，Studio 不展示内容。</Text>
                    </Show>
                    <Show when={sel().truncated}><Text class="text-xs" style={{ textColor: C.warn }}>内容已截断（只显示前 128 KiB）。</Text></Show>
                    <Show when={sel().text !== undefined}>
                      <For each={rawLines().slice(0, MAX_RAW_LINES)}>
                        {(line) => <Text class="text-xs font-mono" style={{ textColor: C.body }}>{line.length ? line : " "}</Text>}
                      </For>
                      <Show when={rawLines().length > MAX_RAW_LINES}>
                        <Text class="text-xs" style={{ textColor: C.warn }}>{`… 还有 ${rawLines().length - MAX_RAW_LINES} 行未显示`}</Text>
                      </Show>
                    </Show>
                  </Panel>
                )}
              </Show>
            </View>
          </ScrollablePage>
        </View>
      </View>
    </View>
  );
}

export function ArtifactsPage(props: { studio: Studio }) {
  return <ArtifactsPane studio={props.studio} />;
}
