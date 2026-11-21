import { For, Show, createEffect } from "solid-js";
import { MobileSegmentedControl, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "../components/info.tsx";
import { formatTime, shortHash } from "../lib/format.ts";
import type { Studio } from "../state/studio.ts";
import { Eyebrow, HairlineH, HairlineV, StudioButton } from "../components/workbench-ui.tsx";

/** Signed local OTA publish & offline archive inspector — matches Web Preview `.test-publish-panel`. */
export function PublishPage(props: { studio: Studio; inspector?: boolean }) {
  const s = props.studio;
  const pub = fromStore(s.publish.store);
  const build = fromStore(s.build.store);
  const project = () => s.projects.current();
  const busy = () => pub().phase === "publishing";
  const label = () => (pub().channel === "test" ? "测试" : "稳定版");
  const root = () => pub().targets.find((t) => t.kind === "root");
  const reused = () => pub().targets.filter((t) => t.kind === "reused");
  const logLines = () => { build(); return s.build.tail(8); };
  const lastPublish = () => pub().lastPublish ?? pub().info;

  createEffect(() => {
    const p = project();
    if (p && pub().planState === "idle") void s.publish.enter();
  });

  const copy = (text: string, what: string) => { void s.copy(text, what); };

  const PlanAndOfflineCards = () => (
    <View class="flex-col gap-2.5 w-full">
      <Panel
        title={`发布计划 · ${label()}`}
        eyebrow="测试包 / 热更新"
        tone="blue"
        note="发布只签名已保存并已成功构建的版本；密钥保存在本地服务中，Studio 看不到密钥。"
      >
        <Show when={pub().planState === "loading"}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取发布目标…</Text></Show>
        <Show when={pub().planState === "error"}><Text class="text-xs" style={{ textColor: C.danger }}>{`读取发布目标失败：${pub().planError}`}</Text></Show>
        <Show when={project() === undefined}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
        <Show when={root()}>
          {(t) => (
            <View class="flex-col gap-1 w-full">
              <Line label="主应用" value={`${t().title}（${t().appId}）`} />
              <Line label="版本" value={t().version ? `v${t().version}${t().build !== undefined ? ` · 构建 ${t().build}` : ""}` : undefined} />
              <Line label="构建状态" value={t().busy ? "正在构建" : t().built ? "已构建（可发布）" : "需先构建"} tone={t().built && !t().busy ? "ok" : "warn"} />
              <Line label={`${label()}频道现有版本`} value={t().publishedVersion ? `v${t().publishedVersion}${t().publishedBuild !== undefined ? ` · 构建 ${t().publishedBuild}` : ""}` : "尚无发布记录"} />
              <Line label="槽位所有者" value={`当前项目（${project()}）`} />
              <Show when={t().reason && !t().canPublish}><Text class="text-xs" style={{ textColor: C.warn }}>{t().reason}</Text></Show>
            </View>
          )}
        </Show>
        <Show when={reused().length > 0}>
          <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`复用的已发布包（${reused().length}）`}</Text>
          <For each={reused()}>
            {(t) => (
              <View class="flex-col w-full">
                <Text class="text-xs" style={{ textColor: C.body }}>{`${t.title}（${t.appId}）`}</Text>
                <Text class="text-xs" style={{ textColor: t.canSelect === false || !t.ownerProjectId ? C.warn : C.muted }}>
                  {t.ownerProjectId
                    ? `槽位所有者：${t.ownerTitle ?? t.ownerProjectId} · ${t.publishedVersion ? `v${t.publishedVersion}${t.publishedBuild !== undefined ? ` 构建 ${t.publishedBuild}` : ""}` : "尚无此频道发布版本"}`
                    : (t.reason ?? "无法解析所属项目")}
                </Text>
              </View>
            )}
          </For>
        </Show>
        <Show when={pub().planState === "ready" && reused().length === 0 && root()}>
          <Text class="text-2xs" style={{ textColor: C.faint }}>发布范围：主应用和此项目内的普通子包。</Text>
        </Show>
      </Panel>

      <Panel title="离线包" eyebrow="OFFLINE ARCHIVE" note="把当前构建打包为完整的 .tar.gz（根包、子应用、签名清单与资源）。不会更改任何频道。">
        <View class="flex-row">
          <StudioButton
            label={pub().offline.phase === "working" ? "正在生成…" : "生成离线包"}
            kind="secondary"
            size="xs"
            disabled={!project() || pub().offline.phase === "working"}
            onPress={() => void s.publish.makeOffline()}
          />
        </View>
        <Show when={pub().offline.phase === "done"}>
          <Field label="离线包" value={pub().offline.filename} />
          <Field label="下载地址" value={pub().offline.archiveUrl} onCopy={copy} copyLabel="离线包地址" />
        </Show>
        <Show when={pub().offline.phase === "error"}>
          <Text class="text-xs" style={{ textColor: C.danger }}>{pub().offline.error}</Text>
        </Show>
      </Panel>
    </View>
  );

  const ResultCards = () => (
    <View class="flex-col gap-2.5 w-full">
      <Show when={busy()}>
        <Panel title="发布进度" eyebrow="SIGNING" tone="warn">
          <Text class="text-xs" style={{ textColor: C.warn }}>{pub().step}</Text>
          <For each={logLines()}>
            {(line) => <Text class="text-xs font-mono" style={{ textColor: C.muted }}>{line.text.length ? line.text : " "}</Text>}
          </For>
        </Panel>
      </Show>
      <Show when={pub().phase === "error"}>
        <Panel title="发布失败" eyebrow="ERROR"><Text class="text-xs" style={{ textColor: C.danger }}>{pub().error}</Text></Panel>
      </Show>
      <Show
        when={lastPublish()}
        fallback={
          <Show when={!busy() && pub().phase !== "error"}>
            <View class="p-3 rounded-lg w-full" style={{ bgColor: C.bgRaised, borderColor: C.line, borderWidth: 1, radius: 7 }}>
              <Text class="text-xs" style={{ textColor: C.muted }}>此项目还没有发布记录。构建成功后点击“发布测试包”。</Text>
            </View>
          </Show>
        }
      >
        {(info) => (
          <View class="flex-col gap-2.5 w-full">
            <Panel
              title={pub().fresh ? `发布完成 · ${info().channel === "release" ? "稳定版" : "测试"}` : `最近一次发布 · ${info().channel === "release" ? "稳定版" : "测试"}`}
              eyebrow="SIGNED RELEASE"
              tone={pub().fresh ? "emerald" : "default"}
            >
              <Line label="版本" value={info().version ? `v${info().version}` : undefined} />
              <Line label="构建号" value={info().build} />
              <Line label="源码修订" value={info().revision !== undefined ? `r${info().revision}` : undefined} />
              <Line label="发布时间" value={formatTime(info().publishedAt)} />
              <Field label="签名密钥 ID" value={info().keyId} onCopy={copy} />
              <Field label="运行时 ABI" value={info().runtimeAbi} shown={info().runtimeAbi ? shortHash(info().runtimeAbi!, 26, 8) : undefined} onCopy={copy} />
              <Field label="payload SHA-256" value={info().payloadSha256} shown={info().payloadSha256 ? shortHash(info().payloadSha256!, 20, 8) : undefined} copyLabel="payload SHA-256" onCopy={copy} />
              <Field label="清单地址 (latest.json)" value={info().manifestUrl} copyLabel="清单地址" onCopy={copy} />
              <Field label="host.json 地址" value={info().hostConfigUrl} copyLabel="host.json 地址" onCopy={copy} />
              <Field label="App 接入地址" value={info().appConfigUrl} copyLabel="App 接入地址" onCopy={copy} />
              <Field label="归档（.tar.gz）" value={info().archiveUrl} copyLabel="归档地址" onCopy={copy} />
              <Show when={info().packages.length > 0}>
                <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`已发布的包（${info().packages.length}）`}</Text>
                <For each={info().packages}>
                  {(p) => <Text class="text-xs font-mono" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build}`}</Text>}
                </For>
              </Show>
              <Show when={info().reusedPackages.length > 0}>
                <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`复用的包（${info().reusedPackages.length}）`}</Text>
                <For each={info().reusedPackages}>
                  {(p) => <Text class="text-xs font-mono" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build}${p.ownerProjectId ? ` · 所有者 ${p.ownerProjectId}` : ""}`}</Text>}
                </For>
              </Show>
            </Panel>
            <Show when={info().cosError}>
              <Panel title="腾讯云 COS 自动同步未完成（本地发布已成功）" eyebrow="COS WARNING" tone="warn">
                <Text class="text-xs" style={{ textColor: C.warn }}>{info().cosError}</Text>
              </Panel>
            </Show>
            <Show when={info().cosPublish}>
              {(cosPub) => (
                <Panel title="腾讯云 COS 云端同步结果" eyebrow="TENCENT CLOUD COS" tone="emerald" note="云端签名清单与按需网络资源已同步到腾讯云 COS。">
                  <Line
                    label="COS 摘要"
                    value={`${cosPub().slot === "stable" || cosPub().slot === "release" ? "稳定版" : "测试版"}${cosPub().version ? ` v${cosPub().version}` : ""}${cosPub().build !== undefined ? ` · 构建 ${cosPub().build}` : ""} · 上传 ${cosPub().uploadedFiles ?? 0} 个文件 / 复用 ${cosPub().skippedFiles ?? 0} 个文件`}
                    tone="ok"
                  />
                  <Field label="COS App 接入地址" value={cosPub().appConfigUrl} copyLabel="COS App 接入地址" onCopy={copy} />
                  <Field label="COS 清单地址 (latest.json)" value={cosPub().manifestUrl} copyLabel="COS 清单地址" onCopy={copy} />
                </Panel>
              )}
            </Show>
          </View>
        )}
      </Show>
    </View>
  );

  return (
    <View class="flex-col flex-1 h-full w-full" style={{ bgColor: props.inspector ? C.surface : C.bg, minH: 0 }}>
      {/* Header & Channel Action Bar */}
      <View class="flex-col gap-2 px-3 py-2 w-full" style={{ bgColor: C.surface, shrink: 0 }}>
        <View class="flex-row items-center justify-between gap-2 w-full">
          <View class="flex-col gap-0.5" style={{ minW: 0 }}>
            <Eyebrow text="RELEASE & OTA" />
            <Text class="text-xs font-bold" style={{ textColor: C.text }}>{`发布 · ${project() ?? "请选择项目"}`}</Text>
          </View>
          <StudioButton label="刷新" kind="quiet" size="xs" disabled={!project()} onPress={() => void s.publish.enter()} />
        </View>
        <View class="flex-row items-center gap-2 flex-wrap w-full">
          <View class="flex-1" style={{ minW: 160 }}>
            <MobileSegmentedControl
              items={[{ id: "test", label: "测试频道" }, { id: "release", label: "稳定版频道" }]}
              active={pub().channel}
              onChange={(id) => void s.publish.setChannel(id === "release" ? "release" : "test")}
            />
          </View>
          <StudioButton
            label={busy() ? "发布中…" : pub().channel === "test" ? "发布测试包" : "发布稳定版"}
            kind="primary"
            disabled={!project() || busy() || root()?.canPublish === false}
            onPress={() => void s.publish.publish()}
          />
          <Show when={!busy() && pub().phase === "error" && !build().busy}>
            <StudioButton label="先构建" kind="secondary" disabled={!project()} onPress={() => void s.build.start()} />
          </Show>
        </View>
      </View>
      <HairlineH />

      <Show
        when={!props.inspector}
        fallback={
          <View class="flex-col p-3 flex-1 w-full" style={{ minH: 0 }}>
            <ScrollablePage>
              <View class="flex-col gap-2.5 w-full">
                <PlanAndOfflineCards />
                <ResultCards />
              </View>
            </ScrollablePage>
          </View>
        }
      >
        <View class="flex-row flex-1 w-full" style={{ minH: 0 }}>
          <View class="flex-col p-3 h-full" style={{ width: 340, shrink: 0 }}>
            <ScrollablePage>
              <PlanAndOfflineCards />
            </ScrollablePage>
          </View>
          <HairlineV />
          <View class="flex-col p-3 flex-1 h-full" style={{ minW: 0, minH: 0 }}>
            <ScrollablePage>
              <ResultCards />
            </ScrollablePage>
          </View>
        </View>
      </Show>
    </View>
  );
}
