# Orca fork 发布流程（单人 · Windows）

> 目标：每次出我们自己的 Orca 版本时，把两类上游更新有序集成进来并验证。
> 两类上游性质不同：**stablyai/orca 是源码上游**（git merge 合代码）；**kingsword09/zcode-cli（npm 包 `zcode-app-cli`）是运行时依赖**（不合并代码，升级本机包 + 验证协议兼容）。
> 版本策略：最低门槛 `ZCODE_MINIMUM_VERSIONS`（当前 ≥3.14.5）+ 记录"已验证组合"；CLI 比已验证版本新时结构化告警但不拦截（待实现：launch 时比对并 `logger.warn`）。
> 本流程经 codex 第三方复审修订（2026-10-27），刻意不做的：PR 审批、staging、兼容矩阵、schema 代码生成、签名、CLI 硬上限。

## 名词与 remote 约定

| remote | 指向 | 用途 |
|---|---|---|
| `origin` | stablyai/orca（上游） | 只 fetch，merge 其 main |
| `fork` | KyleQuinn888/orca | 我们的 main，CI 出包 |
| 本地 `main` | 跟随上游 | 不放我们的提交 |

## Step 0 — 前置检查

- 工作区干净，无进行中的 merge。
- `npm view zcode-app-cli version` 记下最新版号（**记下具体版本号**，后面装它，不用 `@latest`——防止安装瞬间 latest 又变）。

## Step 1 — 上游 orca 合并（有更新时）

```bash
git fetch origin                 # ⚠️ 等 fetch 真正完成（曾有 fetch 未完就 merge → 假冲突 7661 文件）
git checkout -b sync-upstream-<日期> fork/main
git merge origin/main
```

- 冲突面：`src/main/native-chat/` 共享文件为主（`src/main/zcode/*` 我们独有，上游无冲突）。
- 解冲突后：`pnpm tc`（或 `npx tsc --noEmit -p tsconfig.json`）+ `vitest run src/main/` + oxlint（改动文件）。

## Step 2 — feature 分支合入 fork/main

- 合**指定的、已审过的分支顶点**（明确列出分支名），不要合一个模糊的 `feat/*` 集合，避免带进废弃工作。
- 合并后**在最终组合顶点再跑一遍** Step 1 的三项检查（之前只测过 post-merge 顶点不够）。

## Step 3 — 基线冒烟（升级 CLI 之前）

用**当前已验证的 CLI 版本**（当前组合：Orca beta0.5 + CLI 3.15.3-36）在 Orca 里跑一轮纯消息回合。

- 目的：把"Orca 侧合并弄坏了会话路径"和"新 CLI 改了协议"两个变量分开。基线失败 → 停，先修 Orca，不碰 CLI。

## Step 4 — CLI 升级 + 协议面检查

```bash
V=$(npm view zcode-app-cli version)      # Step 0 记下的那个
npm install -g zcode-app-cli@$V          # 精确版本，不用 @latest
zcode --version                           # 记录两行：wrapper 版本 + zcode-runtime 版本
cd ~/dev/zcode-app && git pull            # 参考仓同步（补充证据；已装 vendor bundle 才是权威）
```

**协议面三处 grep**（对**新装版本**的 `.../node_modules/zcode-app-cli/vendor/zcode.cjs`）：

1. `attachments` 仍在 session/send schema 且 image 变体字段（filename/mimeType/sizeBytes?/dataBase64?/localPath?）未变；
2. `interaction/requestUserInput` / `requestPermission` 的 result schema 未变（userInput 要 `{action,content.answers 按问题文本}`，permission 要 `{decision}`）；
3. `turn.completed` 事件映射仍在。

grep 是快速绊线不是契约证明——已知盲区：字段改名、required 变化、方法名/路由变化。**最终防线是 Step 6 探针 + Step 7 冒烟**。

## 发布门禁（硬规则）

**不经用户文字批准，不构建任何新版本**——版本号 bump、CI dispatch、本地 electron-builder 出包、交付安装包四类动作都必须先征得同意。修代码/测试/推分支不受此限。

## Step 5 — bump 版本 + 出包

```bash
# package.json: 1.4.238-beta.N → beta.N+1（已 dispatch 即冻结该号，修复出 N+1）
git checkout -b release/beta.N fork/main   # 或直接在 fork/main
# 改版本号 → commit → push fork main
gh workflow run fork-win-installer.yml --repo KyleQuinn888/orca --ref main
gh workflow run mobile-android-release.yml --repo KyleQuinn888/orca --ref main -f publish_github_release=false
```

- dispatch 后确认**两个 run 的 commit SHA 都是我们刚推的顶点**。
- 下载用 curl 断点续传循环（`gh run download` 走代理不可靠）；sha 校验对**本次 run 的** latest.yml/artifact，不用本地旧文件。

## Step 6 — 兼容性探针（release-only 脚本，待建设）

spawn 真实已装 CLI 的 `zcode app-server`：创建会话 → 订阅（desktop-continuous）→ 发纯消息 → 逐行 JSON 解析断言方法名/事件信封/终止事件形状，失败存原始 transcript。

- 覆盖 grep 测不到的东西（路由、事件流真实形状）。
- 不进 vitest/CI（依赖全局包、登录态、付费调用）；发布前手动跑一次。
- 已知障碍：探针与运行中的生产实例疑似存储锁冲突（session/create 挂起）——建设时先解决（独立 ZCODE 存储目录或错峰）。

## Step 7 — 最终验收（必须用下载的安装包）

dev 板可以做**早期拒绝**（协议交互层），但发布验收必须装 **NSIS 安装包**（验证 ASAR 打包、资源、PATH 解析、结构化日志真的落 ndjson）。

冒烟清单（一次会话内）：

1. 纯消息回合，正常回复；
2. 粘贴一张图，模型能描述内容；
3. 触发权限卡并应答（`{decision}` 通道）；
4. 触发问答卡并应答（`{action:'accept'}` 通道——与权限卡形状不同，别只测一个）；
5. 回合结束不转圈（若转圈：`main.trace.ndjson` grep `"scope":"zcode-lane"` 抓诊断）。

APK 也装一下，至少确认版本号和启动。

## Step 8 — 归档

- **回滚对**：上一版安装包保留在 Downloads；上一版 CLI 版本号记录在案。
- **annotated tag**（fork 仓库）记发布元数据——commit message 放不下最终 artifact 哈希且易丢：

```bash
git tag -a mobile-desktop-beta.N -m "Orca <sha> + zcode-app-cli <wrapper> (runtime <runtime>) + exe sha512 <前16位> + apk sha256 <前16位>"
git push fork mobile-desktop-beta.N
```

## 原则

1. **CLI 别拖**：每次出包查一次 npm，落后就 升级+全套验证（协议漂移越拖越大）。
2. **组合要可复现**：任何时点能答出"这个包装的时候配的是哪个 CLI 版本"。
3. **最终验收只认安装包**：dev 板/单测过 ≠ 发布过。
