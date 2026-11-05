// testagent_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "../../tool/tool"

const DESCRIPTION = `向 Jev 决策模型提问。传入 state（上下文）和 questions（问题集合），返回每个问题的结构化判断结果，键名沿用 questions 的键名。Jev 支持三种问题类型：
- choice：给出候选集合，返回选中项 choice、概率分布与置信度
- score：给出有序标签数组，返回分数 score、概率分布与置信度
- noul：只需 instructions，返回单个 0~1 的概率

criteria 的内容随类型变化：choice 传 { 选项名: 选项说明 } 对象，score 传标签字符串数组（数组下标即分值），noul 可省略。`

const Question = Schema.Struct({
  type: Schema.Union([Schema.Literal("choice"), Schema.Literal("score"), Schema.Literal("noul")]).annotate({
    description: "问题类型：choice 选择、score 打分、noul 其余判断",
  }),
  instructions: Schema.String.annotate({
    description: "问题说明，描述希望 Jev 如何判断",
  }),
  criteria: Schema.Unknown.pipe(Schema.optional).annotate({
    description: "判定标准：choice 为 { 选项名: 说明 } 对象，score 为标签字符串数组，noul 可省略",
  }),
})

const Parameters = Schema.Struct({
  state: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]).annotate({
    description: "待判断的上下文，可以是字符串或结构化对象",
  }),
  questions: Schema.Record(Schema.String, Question).annotate({
    description: "问题集合，键名自定义，返回结果会沿用这些键名",
  }),
})

type Answer = {
  choice?: string
  score?: number
  noul?: number
  confidence?: number
  probabilities?: Record<string, number>
  legend?: Record<string, string>
}

type JevMetadata = {
  ok: boolean
  status?: number
  answers?: Record<string, Answer>
}

// 服务地址 base64 编码存储，与 sandbox 工具同一做法，使用前解码。
const BASE_URL_B64 = "aHR0cDovL3Rlc3QtbGxtLnBsYXRmb3JtLmNtYmNoaW5hLmNu"
const ENDPOINT = `${atob(BASE_URL_B64)}/v1/systemone`
const MODEL = "jev-model"
// 内网网关鉴权：优先环境变量，回退到内置 key（建议后续轮换后只保留环境变量）
const KEY = process.env.JEV_API_KEY ?? "sk-1Ugw3r_r3C8wtQZhFE_Kng"

// 三种问题类型的回答形态不同：
//   choice → { choice, probabilities, confidence }
//   score  → { score, legend, probabilities, confidence }
//   noul   → { noul }
// 这里统一渲染成人类可读的多行文本，原始 JSON 留在 metadata.answers 里。
function percent(value: number | undefined) {
  if (typeof value !== "number") return "-"
  return `${Math.round(value * 100)}%`
}

function dominant(probabilities: Record<string, number> | undefined) {
  if (!probabilities) return undefined
  const entries = Object.entries(probabilities)
  if (!entries.length) return undefined
  return entries.reduce((best, item) => (item[1] > best[1] ? item : best))
}

function distribution(probabilities: Record<string, number> | undefined, legend?: Record<string, string>) {
  if (!probabilities) return undefined
  const parts = Object.entries(probabilities).map(([name, value]) => {
    const label = legend?.[name]
    return label ? `${name}(${label}) ${percent(value)}` : `${name} ${percent(value)}`
  })
  return parts.length ? `  分布：${parts.join("、")}` : undefined
}

function render(answer: Answer) {
  if (typeof answer.noul === "number") return `${percent(answer.noul)}`

  if (typeof answer.score === "number") {
    const best = dominant(answer.probabilities)
    const label = best ? answer.legend?.[best[0]] : undefined
    const confidence = typeof answer.confidence === "number" ? `，置信度 ${percent(answer.confidence)}` : ""
    return label ? `${answer.score}（${label}${confidence}）` : `${answer.score}${confidence}`
  }

  if (answer.choice) {
    const confidence = typeof answer.confidence === "number" ? `（置信度 ${percent(answer.confidence)}）` : ""
    return `${answer.choice}${confidence}`
  }

  return JSON.stringify(answer)
}

function format(answers: Record<string, Answer>) {
  const lines = Object.entries(answers).map(([name, answer]) => {
    const head = `- ${name}: ${render(answer)}`
    const detail = distribution(answer.probabilities, answer.legend)
    return detail ? `${head}\n${detail}` : head
  })
  return lines.join("\n")
}

// Effect 4 里 fetch 的 rejection 会变成 defect 直接短路 generator，
// 写在 Effect.gen 里的 try/catch 捕不到，所以错误处理放在普通 async 函数里。
async function call(body: unknown, signal: AbortSignal) {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    return { ok: response.ok, status: response.status, text: await response.text() }
  } catch (err) {
    return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) }
  }
}

export const JevTool = Tool.define(
  "jev",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            call({ model: MODEL, state: params.state, questions: params.questions }, ctx.abort),
          )

          if (!res.ok) {
            const reason = res.status ? `Jev API 请求失败: ${res.status} ${res.text}` : `请求失败：${res.text}`
            return {
              title: "Jev Request Failed",
              output: reason,
              metadata: { ok: false, status: res.status } as JevMetadata,
            }
          }

          const parsed = (() => {
            try {
              return JSON.parse(res.text) as { answers?: Record<string, Answer> }
            } catch {
              return undefined
            }
          })()

          const answers = parsed?.answers
          if (!answers) {
            return {
              title: "Jev Answered",
              output: res.text,
              metadata: { ok: true, status: res.status } as JevMetadata,
            }
          }

          return {
            title: "Jev Answered",
            output: `判断结果：\n${format(answers)}`,
            metadata: { ok: true, status: res.status, answers } as JevMetadata,
          }
        }),
    }
  }),
)
