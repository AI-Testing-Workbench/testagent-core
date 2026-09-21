// testagent_change - api_intel tool. 当前仅启用 FA 平台（见
// packages/testflow/docs/design/fa-api.md）。
//
// apicol（API 协作平台）暂未完成，已【临时下线】：下方 apicol 相关的
// platform 取值、API_INTEL_DESCRIPTION 文案与参数 schema 整体注释保留，
// 恢复时取消注释即可（同时配合 routes.ts 的「apicol 恢复」注释块）。
// platforms/apicol.ts 未删。

import type { Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import { executeAction, type ApiIntelArgs } from "./routes"

const API_INTEL_DESCRIPTION = [
  // apicol 恢复：删除下方 FA-only 的开头两行与鉴权行，改用块注释里的多平台文案。
  "应用接口情报工具（FA 平台）。在自动化测试场景下，先用本工具拿到目标应用的接口契约，再基于契约生成测试用例。",
  "固定 platform=fa，仅支持 action=fetch（无 scan/list/fetchAll）：",
  "  • 传 testProductNo + testApiName + testAppName → 查询平台已登记的接口定义（返回 endpoint + definition）",
  "  • 额外传 outputPath（目录）→ 走「生成接口定义 md 文件」接口，把返回的 base64 数据流解码后写到 <outputPath>/<file_name>（file_name 取自响应）",
  "鉴权：查询接口在请求头注入 Authorization，取自环境变量 TESTAGENT_USER_TOKEN（登录后注入）；生成 md 的接口无需鉴权。",
  "FA 网关地址由环境变量 FA_BASE_URL 指定（默认 testhub-gateway-dev）。",
  "返回：成功 {ok:true, platform:fa, route, data}；失败 {ok:false, platform:fa, route, error, hint}。",
].join("\n")

// ── apicol 恢复：取消下方注释，用块注释里的多平台文案替换上方 FA-only 的
//    「开头两行 + 鉴权行 + 返回行」。
// const API_INTEL_DESCRIPTION = [
//   "应用接口情报工具。在自动化测试场景下，先用本工具拿到目标应用的接口契约，再基于契约生成测试用例。",
//   "通过 `platform` 选择平台：",
//   "  • platform=\"apicol\" → API 协作平台。用 appId + endpointRefs，支持 scan/list/fetch/fetchAll：",
//   "      action=\"scan\"      → 按 systemId(+可选 deployUnit/keyword) 找到应用（返回 appId = projectId）",
//   "      action=\"list\"      → 列出指定 appId 的接口元信息（name/method/path/status 等）",
//   "      action=\"fetch\"     → 按 endpointRefs 获取接口定义（ref 三种格式：name / 'METHOD path' / 'METHOD name'）",
//   "      action=\"fetchAll\"  → 一键返回 appId 下全部接口清单（先返回清单，再调用 fetch 取定义）",
//   "  • platform=\"fa\"     → FA 平台。仅支持 action=\"fetch\"（无 scan/list/fetchAll）。传 testProductNo + testApiName + testAppName 查询接口定义；若额外传 outputPath（目录），则走「生成接口定义 md 文件」接口，把返回的 base64 数据流解码后写到 <outputPath>/<file_name>。",
//   "鉴权：工具从 User.get().sapId 取用户工号；token 接口为 GET /ed/openapi/token?sapId=...，不附加 Header；业务接口自动注入 Authorization: <token>。FA 网关地址由环境变量 FA_BASE_URL 指定。",
//   "返回：成功 {ok:true, platform, route, data}；失败 {ok:false, platform, route, error, hint}。",
// ].join("\n")

export const ApiIntelPlugin: Plugin = async () => {
  return {
    tool: {
      api_intel: {
        description: API_INTEL_DESCRIPTION,
        args: {
          action: z
            .enum(["scan", "list", "fetch", "fetchAll"])
            .describe("仅 fetch 可用；scan/list/fetchAll 属 apicol 工作流，已随 apicol 一并临时下线"),
          platform: z
            .literal("fa")
            .describe("平台标识，当前仅支持 fa（FA 平台）；apicol 暂未完成已临时下线"),
          // apicol 恢复：改回 z.enum(["apicol", "fa"])

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

          // fa: fetch + 写 md 文件。outputPath 有值时走第二个接口（生成 md）。
          outputPath: z
            .string()
            .min(1)
            .optional()
            .describe(
              "fa 专属、可选：目录路径。传入时走「生成接口定义 md 文件」接口，将返回的 base64 数据流解码后写到 <outputPath>/<file_name>（file_name 取自响应）；不传则走查询接口定义的 fetch。",
            ),

          // ── apicol 恢复：取消下方注释 ────────────────────────────────────────
          // systemId: z.string().min(1).optional().describe("scan 必填：系统编号（path 参数）"),
          // deployUnit: z.string().min(1).optional().describe("scan 可选：精确匹配发布单元"),
          // keyword: z.string().min(1).optional().describe("scan 可选：模糊匹配发布单元/项目名"),
          // appId: z.string().min(1).optional().describe("apicol 的 list/fetch/fetchAll 必填：来自 scan 的 appId"),
          // endpointRefs: z
          //   .array(z.string().min(1))
          //   .min(1)
          //   .optional()
          //   .describe("apicol 的 fetch 必填：name / 'METHOD path' / 'METHOD name'"),
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
                platform: "fa",
                action: a.action,
                error: message,
                hint: "检查 testProductNo/testApiName/testAppName 是否齐全，以及 TESTAGENT_USER_TOKEN、FA_BASE_URL 是否正确",
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
