// testagent_change - api_intel tool. First stage supports only the apicol
// (API 协作平台) platform. Calls the real four endpoints documented in
// packages/testflow/docs/design/api.md. Authentication uses the existing
// user chain (User.get().sapId); token endpoint is /ed/openapi/token.

import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import { executeAction, type ApiIntelArgs } from "./routes"

const API_INTEL_DESCRIPTION = [
  "应用接口情报工具。在自动化测试场景下，先用本工具拿到目标应用的接口契约，再基于契约生成测试用例。",
  "通过 `platform` 选择平台：",
  "  • platform=\"apicol\" → API 协作平台。用 appId + endpointRefs，支持 scan/list/fetch/fetchAll：",
  "      action=\"scan\"      → 按 systemId(+可选 deployUnit/keyword) 找到应用（返回 appId = projectId）",
  "      action=\"list\"      → 列出指定 appId 的接口元信息（name/method/path/status 等）",
  "      action=\"fetch\"     → 按 endpointRefs 获取接口定义（ref 三种格式：name / 'METHOD path' / 'METHOD name'）",
  "      action=\"fetchAll\"  → 一键返回 appId 下全部接口清单（先返回清单，再调用 fetch 取定义）",
  "  • platform=\"fa\"     → FA 平台。仅支持 action=\"fetch\"（无 scan/list/fetchAll），用 testProductNo + testApiName + testAppName 查询平台已登记的接口定义。",
  "鉴权：工具从 User.get().sapId 取用户工号；token 接口为 GET /ed/openapi/token?sapId=...，不附加 Header；",
  "      业务接口自动注入 Authorization: <token>（FA 的 accessToken 与 apicol 同源）。FA 网关地址由环境变量 FA_BASE_URL 指定。",
  "返回：成功 {ok:true, platform, route, data}；失败 {ok:false, platform, route, error, hint}。",
].join("\n")

export const ApiIntelPlugin: Plugin = async () => {
  return {
    tool: {
      api_intel: {
        description: API_INTEL_DESCRIPTION,
        args: {
          action: z
            .enum(["scan", "list", "fetch", "fetchAll"])
            .describe("四选一：scan 找应用、list 列接口、fetch 取定义、fetchAll 一键列清单"),
          platform: z
            .enum(["apicol", "fa"])
            .describe("平台标识：apicol（API 协作平台）或 fa（FA 平台，仅支持 fetch）"),

          // scan
          systemId: z
            .string()
            .min(1)
            .optional()
            .describe("scan 必填：系统编号（path 参数）"),
          deployUnit: z
            .string()
            .min(1)
            .optional()
            .describe("scan 可选：精确匹配发布单元"),
          keyword: z
            .string()
            .min(1)
            .optional()
            .describe("scan 可选：模糊匹配发布单元/项目名"),

          // apicol: list / fetch / fetchAll
          appId: z
            .string()
            .min(1)
            .optional()
            .describe("apicol 的 list/fetch/fetchAll 必填：来自 scan 的 appId（实际为 projectId，按 string 传递）"),

          // apicol: fetch
          endpointRefs: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe("apicol 的 fetch 必填：三种格式任选其一：name / 'METHOD path' / 'METHOD name'"),

          // fa: fetch
          testProductNo: z
            .string()
            .min(1)
            .optional()
            .describe("fa 的 fetch 必填：测试产品编号"),
          testApiName: z
            .string()
            .min(1)
            .optional()
            .describe("fa 的 fetch 必填：测试接口名称"),
          testAppName: z
            .string()
            .min(1)
            .optional()
            .describe("fa 的 fetch 必填：测试应用名称"),
        },
        async execute(args, ctx) {
          const a = args as ApiIntelArgs
          try {
            const out = await executeAction(a, ctx)
            return JSON.stringify(out, null, 2)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return JSON.stringify(
              {
                ok: false,
                platform: a.platform ?? "apicol",
                action: a.action,
                error: message,
                hint: "检查必填字段、sapId 是否已通过 /testagent/user 注入，或网络/APICOL_BASE_URL 是否正确",
              },
              null,
              2,
            )
          }
        },
      },
    },
  }
}