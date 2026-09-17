import { Config } from "@/config/config"
import z from "zod"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_SDT from "./prompt/sdt.txt" // testagent_change
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { zod } from "@/util/effect-zod"
import { withStatics, type DeepMutable } from "@/util/schema"

type ReferenceEntry = NonNullable<Config.Info["reference"]>[string]
type ResolvedReference = { kind: "git"; repository: string; branch?: string } | { kind: "local"; path: string }

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})
  .annotate({ identifier: "Agent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultAgent: () => Effect.Effect<string>
  // testagent_change start - override methods
  readonly getSessionOverride: (sessionID: string) => Effect.Effect<{
    prompt?: string
    permission?: Permission.Ruleset
    temperature?: number
    topP?: number
    steps?: number
  } | undefined>
  readonly setSessionOverride: (input: {
    sessionID: string
    prompt?: string
    permission?: Permission.Ruleset
    temperature?: number
    topP?: number
    steps?: number
  }) => Effect.Effect<{ applied: boolean }>
  readonly clearSessionOverride: (input: {
    sessionID: string
  }) => Effect.Effect<void>
  // testagent_change end
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

type State = Omit<Interface, "generate" | "getSessionOverride" | "setSessionOverride" | "clearSessionOverride"> // testagent_change

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

// testagent_change start - SDT memory extraction prompt builder
function buildSdtMemoryExtractionPrompt(skillsDir: string, globalskillsDir: string): string {
  const MEMORY_TYPES = ["user", "feedback", "project", "reference"]
  return [
    "# 角色：专职测试知识沉淀专家",
    "",
    "## 任务",
    "",
    "从会话上下文提取长期可复用的测试知识，通过 `memory_save` 持久化。",
    "",
    "## ⚠️ 最高优先级：合并优先于新建",
    "",
    "调用 `memory_save` 前**必须**先执行 `memory_list` 查重。判断规则：",
    "",
    "1. **相似即更新**：已有记忆的 name 或 description 与本次内容主题相关（同项目、同模块、同流程、包含关系）→ 更新已有记忆，禁止新建；",
    "2. **时序信息合并**：同一项目的进度、状态、检查结果等时效信息，必须追加到已有 project 记忆中，禁止新建；",
    "3. **全新才新建**：只有与所有已有记忆在主题、类型、项目上均无关联时，才可新建。",
    "",
    "**project 类型特别规则**：进度/状态/完成情况的更新一律覆盖已有条目，项目结束时的总结也追加到已有条目中。",
    "",
    "## 记忆类型",
    "",
    "1. **user** — 个人测试偏好：用例输出格式、自动化编码习惯、校验维度、执行步骤；",
    "2. **feedback** — 踩坑复盘：漏测场景、脚本不稳定诱因、线上故障、元素定位问题、环境规避方案；",
    "3. **project** — 项目上下文：测试计划、用例设计、缺陷、风险、业务流程、接口逻辑、历史缺陷、回归范围（不能从代码推导）；",
    "4. **reference** — 外部资源索引：URL、工具名、查阅位置（仅记录地址和场景，不复制内容）。",
    "",
    "## 切勿保存",
    "",
    `- 已在 Skill（\`${skillsDir}\` / \`${globalskillsDir}\`）中沉淀的规则、方法、流程；`,
    "- 代码模式、架构、文件结构——可从代码推导；",
    "- Git 历史、近期更改（`git log` / `git blame` 是权威来源）；",
    "- 调试解决方案——修复已在代码中；",
    "- AGENT.md 或项目配置文件中的内容；",
    "- 临时操作、单次调试日志、闲聊、短期过渡方案；",
    "- 与已有记忆主题重复或高度相似的内容。",
    "",
    "## 保存格式",
    "",
    "```markdown",
    "---",
    "name: {{简短主题名称}}",
    "description: {{单行描述——用于语义检索，需具体清晰}}",
    `type: {{${MEMORY_TYPES.join(" / ")}}}`,
    "source: sdt",
    "---",
    "",
    "{{核心规则/事实}}",
    "**Why:** {{价值/风险/诱因}}",
    "**How to apply:** {{落地执行方法}}",
    "```",
    "",
    "## 执行步骤",
    "",
    "分析 → 查重（memory_list） → 比对（语义判断相似/全新） → 决策（相似则更新、全新才新建） → 保存（memory_save） → 验证（Why + How to apply 段落）",
    "",
    "## 约束",
    "",
    "- 每次会话 0-3 条，质量重于数量；",
    "- 多条记忆分开输出，无开场白/解释/总结；",
    "- 不保存提取过程本身的元信息。",
  ].join("\n")
}
// testagent_change end

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    
    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        // testagent_change start - 获取项目和全局 skills 目录
        const projectSkillsDir = skillDirs.find(dir => !dir.includes(Global.Path.home)) || path.join(ctx.worktree, ".testagent", "skills")
        const globalSkillsDir = skillDirs.find(dir => dir.includes(Global.Path.home)) || path.join(Global.Path.home, ".testagent", "skills")
        // testagent_change end
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          sandbox: "deny",
          question: "deny",
          toast: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          repo_clone: "deny",
          repo_overview: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "The default agent. Executes tools based on configured permissions.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          plan: {
            name: "plan",
            description: "Plan mode. Disallows all edit tools.",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.join(".testagent", "plans", "*.md")]: "allow", // testagent_change
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          // testagent_change start
          sdt: {
            name: "sdt",
            description: "SDT test framework subagent",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
                question: "allow",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            prompt: PROMPT_SDT,
          },
          "sdt-memory-extraction": {
            name: "sdt-memory-extraction",
            description: "Review conversation message and extract any information worth remembering for future sessions",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                "memory_list": "allow",
                "memory_save": "allow",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            prompt: buildSdtMemoryExtractionPrompt(projectSkillsDir, globalSkillsDir),
          },
          // testagent_change end
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "deny",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          ...(Flag.OPENCODE_EXPERIMENTAL_SCOUT
            ? {
                scout: {
                  name: "scout",
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({
                      "*": "deny",
                      grep: "allow",
                      glob: "allow",
                      webfetch: "deny",
                      websearch: "allow",
                      codesearch: "allow",
                      read: "allow",
                      repo_clone: "allow",
                      repo_overview: "allow",
                      external_directory: {
                        ...readonlyExternalDirectory,
                        [path.join(Global.Path.repos, "*")]: "allow",
                      },
                    }),
                    user,
                  ),
                  description: `Docs and dependency-source specialist. Use this when you need to inspect external documentation, clone dependency repositories into the managed cache, and research library implementation details without modifying the user's workspace.`,
                  prompt: PROMPT_SCOUT,
                  options: {},
                  mode: "subagent" as const,
                  native: true,
                },
              }
            : {}),
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        function referencePath(value: string) {
          if (value.startsWith("~/")) return path.join(Global.Path.home, value.slice(2))
          return path.isAbsolute(value)
            ? value
            : path.resolve(ctx.worktree === "/" ? ctx.directory : ctx.worktree, value)
        }

        function resolveReference(reference: ReferenceEntry): ResolvedReference {
          if (typeof reference === "string") {
            if (reference.startsWith(".") || reference.startsWith("/") || reference.startsWith("~")) {
              return { kind: "local", path: referencePath(reference) }
            }
            return { kind: "git", repository: reference }
          }
          if ("path" in reference) return { kind: "local", path: referencePath(reference.path) }
          return { kind: "git", repository: reference.repository, branch: reference.branch }
        }

        function referencePrompt(name: string, reference: ResolvedReference) {
          if (reference.kind === "local") {
            return [
              PROMPT_SCOUT,
              `You are Scout reference @${name}. This reference points to a local directory outside or alongside the current workspace.`,
              `Local directory: ${reference.path}`,
              `When invoked, inspect this directory as the primary reference source. Prefer repo_overview with path ${JSON.stringify(reference.path)} before broader searches. Do not edit files.`,
            ].join("\n\n")
          }

          return [
            PROMPT_SCOUT,
            `You are Scout reference @${name}. This reference points to a git repository.`,
            `Repository: ${reference.repository}`,
            ...(reference.branch ? [`Branch/ref: ${reference.branch}`] : []),
            `When invoked, clone or refresh this repository with repo_clone, then inspect the cached repository as the primary reference source. Do not edit files.`,
          ].join("\n\n")
        }

        if (Flag.OPENCODE_EXPERIMENTAL_SCOUT) {
          for (const [name, reference] of Object.entries(cfg.reference ?? {})) {
            if (agents[name]) continue
            const resolved = resolveReference(reference)
            const localPath = resolved.kind === "local" ? resolved.path : undefined
            agents[name] = {
              name,
              description:
                resolved.kind === "local"
                  ? `Scout reference for local directory ${resolved.path}`
                  : `Scout reference for repository ${resolved.repository}`,
              permission: Permission.merge(
                agents.scout.permission,
                Permission.fromConfig(
                  localPath
                    ? {
                        external_directory: {
                          [localPath]: "allow",
                          [path.join(localPath, "*")]: "allow",
                        },
                      }
                    : {},
                ),
              ),
              prompt: referencePrompt(name, resolved),
              options: { reference },
              mode: "subagent",
              native: false,
            }
          }
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    // testagent_change start - transient override map for per-stage subagent config
    const overrideMap = new Map<string, { prompt?: string; permission?: Permission.Ruleset; temperature?: number; topP?: number; steps?: number }>()
    // testagent_change end

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      // testagent_change start - override methods
      getSessionOverride: Effect.fn("Agent.getSessionOverride")(function* (sessionID: string) {
        return overrideMap.get(sessionID)
      }),
      setSessionOverride: Effect.fn("Agent.setSessionOverride")(function* (input: {
        sessionID: string
        prompt?: string
        permission?: Permission.Ruleset
        temperature?: number
        topP?: number
        steps?: number
      }) {
        overrideMap.set(input.sessionID, {
          prompt: input.prompt,
          permission: input.permission,
          temperature: input.temperature,
          topP: input.topP,
          steps: input.steps,
        })
        return { applied: true }
      }),
      clearSessionOverride: Effect.fn("Agent.clearSessionOverride")(function* (input: {
        sessionID: string
      }) {
        overrideMap.delete(input.sessionID)
      }),
      // testagent_change end
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = (cfg.experimental?.openTelemetry ?? true) // testagent_change
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry ?? true, // testagent_change
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Agent from "./agent"
