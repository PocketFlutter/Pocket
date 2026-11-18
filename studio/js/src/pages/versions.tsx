import { For, Show, onMount } from "solid-js";
import { InputField, MobileButton, MobileListTile, MobileSwitch, ScrollablePage } from "@pocket/ui";
import { Text, View } from "@pocketjs/framework/solid/components";
import { fromStore } from "../ui/bind.ts";
import { C } from "../ui/theme.ts";
import { Field, Line, Panel } from "../components/info.tsx";
import { cosSourceLabel } from "../state/cos.ts";
import { formatTime, shortHash } from "../lib/format.ts";
import type { Studio } from "../state/studio.ts";

/**
 * Version history and slots from the service's journal, plus Tencent Cloud COS cloud asset & OTA publishing.
 * The service records what was PUBLISHED; whether a device is on trial, promoted or rolled back is decided by
 * each device's update coordinator and is not visible here.
 */
export function VersionsPage(props: { studio: Studio }) {
  const s = props.studio;
  const v = fromStore(s.versions.store);
  const cos = fromStore(s.cos.store);
  const project = () => s.projects.current();
  onMount(() => {
    const p = project();
    if (p) {
      void s.versions.refresh();
      void s.cos.load(p);
    }
  });
  const copy = (text: string, what: string) => { void s.copy(text, what); };
  const selected = () => v().history.find((e) => e.id === v().selected);
  const isCurrent = (id: string, slot: string) => v().slots.some((x) => x.name === slot && x.releaseId === id);
  const cosBusy = () => cos().loading || cos().saving || cos().checking || cos().publishing;
  const localInfo = () => cos().snapshot?.local;
  const discoveredBuckets = () => localInfo()?.discoveredBuckets ?? [];
  const defaultBucket = () => localInfo()?.defaultBucket;
  const publishedCos = () => cos().snapshot?.published;

  return (
    <View class="flex-col gap-2 p-4 flex-1">
      <View class="flex-row items-center gap-3">
        <Text class="text-xl text-[#FAFAFA] font-bold">{`版本 · ${project() ?? "请选择项目"}`}</Text>
        <MobileButton
          label="刷新"
          kind="text"
          compact
          disabled={!project()}
          onPress={() => {
            const p = project();
            if (p) {
              void s.versions.refresh();
              void s.cos.load(p);
            }
          }}
        />
        <Show when={v().loading || cos().loading}><Text class="text-xs" style={{ textColor: C.muted }}>正在读取…</Text></Show>
      </View>
      <Show when={v().error}><Text class="text-xs" style={{ textColor: C.danger }}>{`读取版本记录失败：${v().error}`}</Text></Show>
      <Show when={project() === undefined}><Text class="text-xs" style={{ textColor: C.muted }}>请先在“项目”页打开一个项目。</Text></Show>
      <View class="flex-row gap-3 flex-1">
        <View class="flex-col flex-1">
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Panel title="本地版本后端" note="只读：提供已签名的测试 / 稳定版本给模拟器和局域网设备。">
                <Line label="服务地址" value={v().origin} />
                <Line label="宿主版本" value={v().hostVersion} />
                <Line label="兼容分支" value={v().packageVersion} />
                <Line label="网络" value={v().loaded ? (v().lan ? "局域网可访问" : "仅本机（127.0.0.1）") : undefined} />
                <Show when={v().backendError}><Text class="text-xs" style={{ textColor: C.warn }}>{v().backendError}</Text></Show>
                <Field label="App 接入地址（固定频道 latest.json）" value={v().appConfigUrl} copyLabel="App 接入地址" onCopy={copy} />
              </Panel>
              <For each={v().slots}>{(slot) => (
                <Panel title={slot.label}>
                  <Show when={slot.version} fallback={<Text class="text-xs" style={{ textColor: C.muted }}>此槽位还没有发布。</Text>}>
                    <Line label="当前版本" value={`v${slot.version}${slot.build !== undefined ? ` · 构建 ${slot.build}` : ""}`} tone="ok" />
                    <Show when={slot.archiveUrl}><Field label="归档下载" value={slot.archiveUrl} copyLabel="归档地址" onCopy={copy} /></Show>
                    <For each={slot.packages}>{(p) => <Text class="text-xs" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build}`}</Text>}</For>
                    <For each={slot.reusedPackages}>{(p) => <Text class="text-xs" style={{ textColor: C.muted }}>{`${p.id} · v${p.version} · 构建 ${p.build} · 复用${p.ownerProjectId ? `（所有者 ${p.ownerProjectId}）` : ""}`}</Text>}</For>
                  </Show>
                </Panel>
              )}</For>
              <Panel title={`已发布版本（${v().history.length}）`}>
                <Show when={v().loaded && v().history.length === 0}><Text class="text-xs" style={{ textColor: C.muted }}>还没有发布记录。在“发布”页发布一个测试包。</Text></Show>
                <For each={v().history}>{(e) => (
                  <MobileListTile
                    title={`v${e.version} · 构建 ${e.build}${isCurrent(e.releaseId, e.slot) ? " · 当前" : ""}`}
                    detail={`${e.slot === "test" ? "测试" : "稳定版"} · ${formatTime(e.publishedAt) ?? "时间未知"}`}
                    selected={v().selected === e.id}
                    onPress={() => s.versions.select(e.id)}
                  />
                )}</For>
              </Panel>
              <Text class="text-xs" style={{ textColor: C.faint }}>
                试用 / 已提升 / 已回滚：这些状态由各设备上的更新协调器按签名、ABI 和健康检查决定，本地服务不记录，所以这里不显示。此处只列出已发布的版本。
              </Text>
              <Panel title="腾讯云 COS 云端素材与热更发布" note="自动检测本机 ~/.cos.yaml、~/.cos.conf、环境变量或 Studio 工作区凭据，将签名包与网络资源同步到 COS。">
                <Line
                  label="本机凭据状态"
                  value={cosSourceLabel(localInfo())}
                  tone={localInfo()?.available ? "ok" : "warn"}
                />
                <Show when={localInfo()?.source}><Line label="凭据来源" value={localInfo()!.source} /></Show>
                <Show when={localInfo()?.sourceDetail}><Line label="来源详情" value={localInfo()!.sourceDetail} /></Show>
                <Show when={localInfo()?.maskedSecretId}><Line label="SecretId" value={localInfo()!.maskedSecretId} /></Show>

                <Show when={discoveredBuckets().length > 0 || defaultBucket()}>
                  <Text class="text-xs" style={{ textColor: C.faint }}>已发现存储桶（点击快速填入）</Text>
                  <View class="flex-row flex-wrap gap-1.5 w-full">
                    <Show when={defaultBucket()}>
                      {(def) => (
                        <MobileButton
                          label={`默认: ${def().bucket} (${def().region})`}
                          kind="tonal"
                          compact
                          disabled={!project() || cosBusy()}
                          onPress={() => s.cos.pickDiscoveredBucket(def().bucket, def().region)}
                        />
                      )}
                    </Show>
                    <For each={discoveredBuckets()}>{(b) => (
                      <MobileButton
                        label={`${b.alias ? `${b.alias} · ` : ""}${b.bucket} (${b.region})`}
                        kind={cos().draft.bucket === b.bucket && cos().draft.region === b.region ? "filled" : "outlined"}
                        compact
                        disabled={!project() || cosBusy()}
                        onPress={() => s.cos.pickDiscoveredBucket(b.bucket, b.region)}
                      />
                    )}</For>
                  </View>
                </Show>

                <MobileSwitch
                  label="启用 COS"
                  value={cos().draft.enabled}
                  disabled={!project() || cosBusy()}
                  onChange={(enabled) => s.cos.patchDraft({ enabled })}
                />
                <MobileSwitch
                  label="发布后自动同步 COS"
                  value={cos().draft.syncOnPublish}
                  disabled={!project() || cosBusy()}
                  onChange={(syncOnPublish) => s.cos.patchDraft({ syncOnPublish })}
                />

                <Text class="text-xs" style={{ textColor: C.faint }}>存储桶 (Bucket)</Text>
                <InputField
                  value={() => cos().draft.bucket}
                  onInput={(bucket) => s.cos.patchDraft({ bucket })}
                  placeholder="examplebucket-1250000000"
                />
                <Text class="text-xs" style={{ textColor: C.faint }}>地域 (Region)</Text>
                <InputField
                  value={() => cos().draft.region}
                  onInput={(region) => s.cos.patchDraft({ region })}
                  placeholder="ap-guangzhou"
                />
                <Text class="text-xs" style={{ textColor: C.faint }}>对象前缀 (Key Prefix)</Text>
                <InputField
                  value={() => cos().draft.keyPrefix}
                  onInput={(keyPrefix) => s.cos.patchDraft({ keyPrefix })}
                  placeholder="pocket-ota"
                />
                <Text class="text-xs" style={{ textColor: C.faint }}>自定义公网域名 (Public Base URL，可选)</Text>
                <InputField
                  value={() => cos().draft.publicBaseUrl}
                  onInput={(publicBaseUrl) => s.cos.patchDraft({ publicBaseUrl })}
                  placeholder="https://cdn.example.com"
                />

                <Text class="text-xs font-bold" style={{ textColor: C.body }}>工作区凭据（本机 0600 权限保存，不写入项目 Git）</Text>
                <Text class="text-xs" style={{ textColor: C.faint }}>SecretId</Text>
                <InputField
                  value={() => cos().secretIdInput}
                  onInput={(secretId) => s.cos.setCredentialInputs({ secretId })}
                  placeholder="AKID..."
                />
                <Text class="text-xs" style={{ textColor: C.faint }}>SecretKey</Text>
                <InputField
                  value={() => cos().secretKeyInput}
                  onInput={(secretKey) => s.cos.setCredentialInputs({ secretKey })}
                  placeholder="SecretKey（保存后立即清空输入框）"
                />
                <Text class="text-xs" style={{ textColor: C.faint }}>SecurityToken（临时密钥可选）</Text>
                <InputField
                  value={() => cos().securityTokenInput}
                  onInput={(securityToken) => s.cos.setCredentialInputs({ securityToken })}
                  placeholder="可选"
                />
                <View class="flex-row flex-wrap gap-2">
                  <MobileButton
                    label={cos().saving ? "保存中…" : "保存工作区凭据"}
                    kind="tonal"
                    compact
                    disabled={!project() || cosBusy() || !cos().secretIdInput.trim() || !cos().secretKeyInput.trim()}
                    onPress={() => void s.cos.saveWorkspaceCredentials()}
                  />
                  <MobileButton
                    label="清除工作区凭据"
                    kind="outlined"
                    compact
                    disabled={!project() || cosBusy()}
                    onPress={() => void s.cos.clearWorkspaceCredentials()}
                  />
                </View>

                <View class="flex-row flex-wrap gap-2">
                  <MobileButton
                    label={cos().saving ? "保存中…" : "保存配置"}
                    kind="filled"
                    compact
                    disabled={!project() || cosBusy()}
                    onPress={() => void s.cos.saveConfig()}
                  />
                  <MobileButton
                    label={cos().checking ? "验证中…" : "验证连接"}
                    kind="tonal"
                    compact
                    disabled={!project() || cosBusy()}
                    onPress={() => void s.cos.checkConnection()}
                  />
                  <MobileButton
                    label={cos().publishing ? "上传中…" : "上传测试版到 COS"}
                    kind="tonal"
                    compact
                    disabled={!project() || cosBusy()}
                    onPress={() => void s.cos.publishChannel("test")}
                  />
                  <MobileButton
                    label={cos().publishing ? "上传中…" : "上传稳定版到 COS"}
                    kind="outlined"
                    compact
                    disabled={!project() || cosBusy()}
                    onPress={() => void s.cos.publishChannel("release")}
                  />
                </View>

                <Show when={cos().error}>
                  <Text class="text-xs" style={{ textColor: C.danger }}>{cos().error}</Text>
                </Show>

                <Show when={cos().checkResult}>
                  {(chk) => (
                    <Text class="text-xs" style={{ textColor: chk().ok ? C.ok : C.danger }}>
                      {chk().ok
                        ? `连接验证通过：${chk().bucket ?? cos().draft.bucket} (${chk().region ?? cos().draft.region})${chk().maskedSecretId ? ` · ${chk().maskedSecretId}` : ""}`
                        : "连接验证未通过"}
                    </Text>
                  )}
                </Show>

                <Show when={publishedCos()?.test}>
                  {(t) => (
                    <View class="flex-col gap-1 w-full">
                      <Line
                        label="COS 测试版"
                        value={`v${t().version ?? "?"}${t().build !== undefined ? ` · 构建 ${t().build}` : ""}${t().uploadedFiles !== undefined ? ` · 上传 ${t().uploadedFiles} / 复用 ${t().skippedFiles ?? 0}` : ""}`}
                        tone="ok"
                      />
                      <Field label="COS 测试版接入地址" value={t().appConfigUrl} copyLabel="COS 测试版接入地址" onCopy={copy} />
                    </View>
                  )}
                </Show>

                <Show when={publishedCos()?.stable}>
                  {(st) => (
                    <View class="flex-col gap-1 w-full">
                      <Line
                        label="COS 稳定版"
                        value={`v${st().version ?? "?"}${st().build !== undefined ? ` · 构建 ${st().build}` : ""}${st().uploadedFiles !== undefined ? ` · 上传 ${st().uploadedFiles} / 复用 ${st().skippedFiles ?? 0}` : ""}`}
                        tone="ok"
                      />
                      <Field label="COS 稳定版接入地址" value={st().appConfigUrl} copyLabel="COS 稳定版接入地址" onCopy={copy} />
                    </View>
                  )}
                </Show>
              </Panel>
            </View>
          </ScrollablePage>
        </View>
        <View class="flex-col gap-2" style={{ width: 340 }}>
          <ScrollablePage>
            <View class="flex-col gap-2 w-full">
              <Show when={selected()} fallback={<Text class="text-xs" style={{ textColor: C.muted }}>选择一个已发布版本查看详情。</Text>}>
                {(e) => (
                  <Panel title={`v${e().version} · 构建 ${e().build}`}>
                    <Line label="频道" value={e().slot === "test" ? "测试" : "稳定版"} />
                    <Line label="源码修订" value={e().revision !== undefined ? `r${e().revision}` : undefined} />
                    <Line label="发布时间" value={formatTime(e().publishedAt)} />
                    <Line label="宿主版本" value={e().hostVersion} />
                    <Field label="发布 ID" value={e().releaseId} onCopy={copy} />
                    <Field label="payload SHA-256" value={e().payloadSha256} shown={e().payloadSha256 ? shortHash(e().payloadSha256!, 20, 8) : undefined} onCopy={copy} />
                    <Field label="归档下载（.tar.gz）" value={e().archiveUrl} copyLabel="归档地址" onCopy={copy} />
                    <Field label="host.json 地址" value={e().appConfigUrl} copyLabel="host.json 地址" onCopy={copy} />
                    <For each={e().packages}>{(p) => (
                      <View class="flex-col w-full">
                        <Text class="text-xs font-bold" style={{ textColor: C.body }}>{`${p.id} · v${p.version} · 构建 ${p.build}`}</Text>
                        <Show when={p.manifestUrl}><Field label="清单" value={p.manifestUrl} copyLabel="清单地址" onCopy={copy} /></Show>
                      </View>
                    )}</For>
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
