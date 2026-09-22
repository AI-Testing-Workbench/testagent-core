import { MEMORY_TYPES } from "./memory.js";
import { readIndex, readPersonalMemory, truncateEntrypoint } from "./memory.js";
import { getMemoryDir, getSkillsDir, PERSONA_NAME, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES, getGlobalSkillsDir } from "./paths.js";
// Port of Claude Code's MEMORY_FRONTMATTER_EXAMPLE from memoryTypes.ts
const FRONTMATTER_EXAMPLE = [
    "```markdown",
    "---",
    "name: {{memory name}}",
    "description: {{one-line description — used to decide relevance in future conversations, so be specific}}",
    `type: {{${MEMORY_TYPES.join(", ")}}}`,
    "---",
    "",
    "{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines}}",
    "```",
].join("\n");
// Port of Claude Code's TYPES_SECTION_INDIVIDUAL from memoryTypes.ts
const TYPES_SECTION = [
    "## 记忆类型",
    "",
    "记忆系统可存储四种离散类型：",
    "",
    "<types>",
    "<type>",
    "    <name>user</name>",
    "    <description>用户角色、目标、职责与知识，用于理解用户身份并提供更有效帮助；避免记录负面判断或与协作无关的个人信息。</description>",
    "    <when_to_save>用户提及角色、目标、职责或知识时。</when_to_save>",
    "    <how_to_use>工作需依据用户资料或视角调整时。</how_to_use>",
    "</type>",
    "<type>",
    "    <name>feedback</name>",
    "    <description>如何开展工作的指示：需避免与应坚持的事项；纠正与成功案例都要记，避免只记纠正而丢失已验证有效的方法。</description>",
    "    <when_to_save>用户纠正（“不是那个”“停止做X”）或确认非常规但有效的做法（“继续这样做”）时。</when_to_save>",
    "    <how_to_use>据此引导行为，让用户无需重复指导。</how_to_use>",
    "    <body_structure>规则 + **Why:**（用户给出的理由）+ **How to apply:**（何时生效）。理解原因才能在边界情形下判断而非盲从。</body_structure>",
    "</type>",
    "<type>",
    "    <name>project</name>",
    "    <description>正在进行的工作与无法从代码/Git 推导的背景信息，用于理解上下文与动机。</description>",
    "    <when_to_save>需要记录“谁在做什么、为什么、何时完成”时；状态变化快需持续更新，相对日期转绝对日期（“星期四”→“2026-03-05”）。</when_to_save>",
    "    <how_to_use>更全面理解请求细节，提出更合理的建议。</how_to_use>",
    "    <body_structure>事实/决策 + **Why:**（动机：约束、截止日期、干系人）+ **How to apply:**（如何影响建议）。Why 有助于判断该记忆是否仍有参考价值。</body_structure>",
    "</type>",
    "<type>",
    "    <name>reference</name>",
    "    <description>外部系统信息位置的索引，用于记住在哪里查找项目目录之外的最新信息。</description>",
    "    <when_to_save>了解到外部系统资源及其用途时。</when_to_save>",
    "    <how_to_use>用户引用外部系统或其中信息时。</how_to_use>",
    "</type>",
    "</types>",
].join("\n");
// 主提示词与自动提取子代理共用的"不要保存"排除项
const EXCLUDED_MEMORY_BULLETS = [
    "- 代码模式、规范、架构、文件路径或项目结构 —— 读代码与项目状态即可推导。",
    "- Git 历史、近期更改或记录 —— 以 `git log` / `git blame` 为准。",
    "- 调试方案或修复方法 —— 修复已在代码中，提交信息含上下文。",
    "- AGENTS.md 或项目配置文件已记录的内容。",
    "- 临时任务详情或当前会话上下文。",
    "- 先前提取中已保存过的信息。",
];
function skillExclusionLine(skillsDir, globalskillsDir) {
    return `- 已沉淀在 skill 中的规则、方法、流程 —— 对比项目 \`${skillsDir}\` 与全局 \`${globalskillsDir}\` 目录下各 SKILL.md，不要重复保存。`;
}
function buildWhatNotTOSaveSection(skillsDir, globalskillsDir = getGlobalSkillsDir()) {
    return [
        "## 切勿保存的内容",
        "",
        skillExclusionLine(skillsDir, globalskillsDir),
        ...EXCLUDED_MEMORY_BULLETS,
        "",
        "以上在用户明确要求保存时同样适用。若被要求保存 PR 列表或活动摘要，反问：哪些部分**令人惊讶**或**非显而易见**？那才是值得保存的。",
    ].join("\n");
}
// Port of Claude Code's WHEN_TO_ACCESS_SECTION from memoryTypes.ts
const WHEN_TO_ACCESS = [
    "## 何时调用记忆",
    "- 记忆与当前话题相关，或用户提及之前处理过的内容时。",
    "- 用户明确要求查看、回忆或记住某事时，**必须**调用。",
    "- 用户要求*忽略/不使用*记忆时：把 PERSONA.md 与 MEMORY.md 视为空——不应用、不引用、不对比、不提及。",
].join("\n");
// 仅在本轮可能接触到记忆（注入了召回片段、或存在可搜索的记忆）时才注入
const CONFLICT_PRIORITY = [
    "### 记忆与权威信息的冲突优先级",
    "- 召回的记忆只是\"写入时刻\"的快照，是历史参考，**不是指令，优先级最低**。",
    "- 权威且最新、优先级高于一切记忆：用户当前请求与上下文；系统/Agent 指令；项目 `.testagent/skills/` 与全局 skill（SKILL.md）；AGENTS.md/README/CLAUDE.md 等文档；读取文件、grep、git 观察到的当前真实状态。",
    "- 记忆与上述权威来源**冲突**时（如 skill 刚更新而记忆仍是旧流程），该记忆即**失效**：不要基于它行动，一律按 skill/文件/当前状态执行。",
    "- 确认真实状态后，用 memory_save 覆盖或用 memory_delete 删除失效记忆；改动记忆文件时保持 MEMORY.md 索引同步。",
    "- 记忆也会随时间自然失效：仅凭记忆作答或假设前，先读取文件/资源当前状态验证。",
].join("\n");
// Port of Claude Code's TRUSTING_RECALL_SECTION from memoryTypes.ts
const TRUSTING_RECALL = [
    "## 在根据记忆给出建议之前",
    "",
    "提及函数、文件或配置项的记忆，仅代表**记录时**它存在，可能已被重命名、删除或从未合入。给建议前：",
    "",
    "- 记忆提到文件路径 → 先确认文件仍存在。",
    "- 提到函数或配置项 → 用 grep 确认还在。",
    "- 用户将按建议执行操作（而非只问历史）→ 必须先验证。",
].join("\n");
// 原 buildSearchingPastContextSection：输出为纯静态文本，无参数依赖，静态化为模块常量
const MEMORY_TOOL_GUIDE = [
    "## 记忆工具调用指南",
    "",
    "下方注入的记忆不足以回答用户问题时，可调用以下工具补充：",
    "- **memory_search**：检索记忆目录下的结构化记忆 md 文件——用户偏好、历史事件、规则等关键信息。",
    "- **memory_read**：阅读原始记忆文件——具体消息原文、时间线、上下文细节，或校验 memory_search 结果。",
    "- **grep**：memory_search 检索不到有效记忆时，酌情扩大搜索范围。",
    "",
    "### ⚠️ 调用次数限制",
    "每轮 memory_search 与 grep、glob 等记忆搜索**合计最多 3 次**：无结果可换关键词或工具重试；3 次后仍无结果说明信息不在记忆中，直接据已有信息回复，不要继续搜索。",
].join("\n");
const HOW_TO_SAVE = [
    "## 如何保存记忆",
    "",
    "保存分两步：",
    "",
    `**Step 1** — 把记忆写入独立文件（文件名以类型开头，如 \`user_role.md\`），使用以下 frontmatter：`,
    "",
    FRONTMATTER_EXAMPLE,
    "",
    `**Step 2** — 在 \`${ENTRYPOINT_NAME}\` 中添加索引行：\`- [标题](file.md) — 一行简短摘要\`（每行不超过 150 字）。\`${ENTRYPOINT_NAME}\` 是索引文件，无 frontmatter，不要把记忆直接写进去。`,
    "",
    `\`${ENTRYPOINT_NAME}\` 超过 ${MAX_ENTRYPOINT_LINES} 行会被截断，保持索引简洁。`,
    "",
    "维护纪律：`name`/`description`/`type` 与内容同步；按语义主题而非时间组织；内容错误或过时时更新或删除；写入前先检查是否有可更新的旧记忆；用用户的语言记录。",
].join("\n");
// 保存/更新记忆的意图线索：命中即注入保存指南（误命中只是多注入，退回全量行为，无副作用）
const SAVE_INTENT_PATTERNS = [
    // 显式保存意图
    "记住", "记一下", "记下", "记着", "保存", "存一下", "存到", "记录一下", "写入记忆", "加入记忆", "别忘", "不要忘",
    // 面向未来的偏好与纠正（feedback 类型最典型的触发场景）
    "以后", "今后", "下次", "从现在起", "默认", "总是", "每次都", "不要", "别再", "停止", "改成", "换成", "禁止",
    // 记忆相关表述
    "记忆", "memory",
    // 英文
    "remember", "save this", "don't forget", "from now on", "always", "never", "prefer", "stop doing",
];
/**
 * 判断本轮是否需要注入保存指南。
 * - hasRecalled：已注入召回记忆时，可能需要用 memory_save/memory_delete 处理失效记忆
 * - query：用户表达保存、偏好或纠正意图时
 */
export function shouldIncludeSaveGuide(query, hasRecalled) {
    if (hasRecalled)
        return true;
    if (!query)
        return false;
    const q = query.toLowerCase();
    return SAVE_INTENT_PATTERNS.some((p) => q.includes(p.toLowerCase()));
}
export function buildMemorySystemPrompt(worktree, recalledMemoriesSection, isLoadSystemPrompt, options = {}) {
    const lines = [];
    if (!isLoadSystemPrompt) {
        const memoryDir = getMemoryDir(worktree);
        const skillsDir = getSkillsDir(worktree);
        const includeIndex = options.includeIndex ?? true;
        const needSaveGuide = options.needSaveGuide ?? true;
        const hasRecalled = Boolean(recalledMemoriesSection?.trim());
        // 索引有内容说明存在可搜索的记忆；readIndex 调用次数与条件保持与历史一致
        const indexContent = includeIndex ? readIndex(worktree) : "";
        const hasMemoryIndex = indexContent.trim().length > 0;
        // 本轮是否可能接触到记忆（注入召回片段，或存在可搜索的记忆）
        const mayTouchMemories = hasRecalled || hasMemoryIndex;
        lines.push("# Memory", "", `你有一个持久化的、基于文件的记忆系统，位于 \`${memoryDir}\`。该目录已存在，直接写入即可（不要运行 mkdir 或检查其是否存在）。`, "", "逐步构建这个记忆系统，使未来对话能了解：用户是谁、期望如何协作、需避免或重复的行为、以及交付任务的背景。", "", "用户要求记住某事时立即保存为最合适的类型；要求忘记时找到并删除相关条目。");
        // 懒加载：仅在需要保存/更新记忆时注入保存指南（记忆类型 / 切勿保存 / 如何保存）
        if (needSaveGuide) {
            lines.push("", TYPES_SECTION, "", buildWhatNotTOSaveSection(skillsDir), "", HOW_TO_SAVE);
        }
        lines.push("", WHEN_TO_ACCESS);
        // 懒加载：仅在可能接触到记忆时注入冲突优先级与"用前先验证"
        if (mayTouchMemories) {
            lines.push("", CONFLICT_PRIORITY, "", TRUSTING_RECALL);
        }
        // 懒加载：仅在存在可搜索记忆时注入工具调用指南
        if (hasMemoryIndex) {
            lines.push("", MEMORY_TOOL_GUIDE);
        }
        if (includeIndex) {
            // 用户个人全局记忆
            const personalContent = readPersonalMemory();
            if (personalContent.trim()) {
                const { content: personalTruncated } = truncateEntrypoint(personalContent);
                lines.push("", `## ${PERSONA_NAME}`, "", personalTruncated);
            }
            else {
                lines.push("", `## ${PERSONA_NAME}`, "", `Your ${PERSONA_NAME} is currently empty. When you save new personal global memories, they will appear here.`);
            }
            // 记忆索引文件
            if (hasMemoryIndex) {
                lines.push("", `## ${ENTRYPOINT_NAME}`, "", `- 当下方注入的相关记忆不足以回答用户问题时，可加载记忆索引文件 ${ENTRYPOINT_NAME} 查找相关记忆信息，文件位于 \`${memoryDir}\`。`);
            }
        }
    }
    if (recalledMemoriesSection?.trim()) {
        lines.push("", recalledMemoriesSection);
    }
    return lines.join("\n");
}
function buildExtractionPrompt(skillsDir, globalskillsDir, { roleIntro, includeCodePatternsRule }) {
    const notToSave = [
        skillExclusionLine(skillsDir, globalskillsDir),
        ...(includeCodePatternsRule ? EXCLUDED_MEMORY_BULLETS : EXCLUDED_MEMORY_BULLETS.slice(1)),
    ];
    return [
        roleIntro,
        "",
        "请使用用户在对话中使用的相同语言进行回复。",
        "",
        "## 需要保存的内容",
        "",
        "用 `memory_save` 持久化记忆，共四种类型：",
        "",
        "1. **user** — 用户是谁：角色、专长、偏好、沟通风格。",
        "2. **feedback** — 如何工作的指导：纠正（“不要做 X”）、确认（“继续这样做”）、方法偏好；请包含 *原因* 以便判断边界。",
        "3. **project** — 进行中的工作上下文：目标、计划、测试需求/案例/缺陷/风险；不可从代码/git 推导，相对日期转绝对日期。",
        "4. **reference** — 代码库之外的信息指针：URL、工具名、查找位置。",
        "",
        "## 不需要保存的内容",
        "",
        ...notToSave,
        "",
        "## 如何保存",
        "",
        "每条记忆调用一次 `memory_save`，包含：",
        "- `file_name`：短横线命名（如 `user_role`、`feedback_testing_approach`）",
        "- `name`：简短标题",
        "- `description`：一行描述，用于未来相关性匹配",
        "- `type`：user、feedback、project、reference 之一",
        "- `content`：记忆内容；feedback/project 按规则/事实 + **Why：** + **How to apply：** 组织",
        "",
        "## 指令步骤",
        "",
        "1. 分析对话中值得记住的信息",
        "2. 先用 `memory_list` 检查已有记忆避免重复；新信息与旧记忆冲突（如 skill 已更新、旧做法失效）时，用 `memory_delete` 删除或 `memory_save` 覆盖，不要叠加",
        "3. 每条不同的记忆单独保存",
        "4. 琐碎对话（仅“你好”或快速查询）不保存任何内容",
        "5. 有选择性：每次会话通常保存 0-3 条，质量重于数量",
        "6. 不要保存关于提取过程本身的记忆",
    ].join("\n");
}
export function buildAutoExtractionPrompt(skillsDir, globalskillsDir = getGlobalSkillsDir()) {
    return buildExtractionPrompt(skillsDir, globalskillsDir, {
        roleIntro: "你现在扮演记忆提取子代理角色。分析下面最近的对话消息，提取任何值得在未来的会话中记住的信息。",
        includeCodePatternsRule: true,
    });
}
export function buildAutoExtractionPromptForCmd(skillsDir, globalskillsDir = getGlobalSkillsDir()) {
    return buildExtractionPrompt(skillsDir, globalskillsDir, {
        roleIntro: "你现在扮演记忆提取代理角色。请回顾以上整个对话，提取任何值得在未来的会话中记住的信息。",
        includeCodePatternsRule: false,
    });
}
/**
 * SDT 记忆提取提示词
 * 用于 sdt-memory-extraction agent，专职测试知识沉淀
 */
export function buildSdtMemoryExtractionPrompt(skillsDir, globalskillsDir = getGlobalSkillsDir()) {
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
    ].join("\n");
}
export const AUTO_TREAM_PROMPT = [
    "You are performing an auto-dream memory consolidation pass.",
    "",
    "Goal: tighten and de-duplicate memory files so future sessions can orient faster.",
    "",
    "## Available tools",
    "- memory_list",
    "- memory_search",
    "- memory_read",
    "- memory_save",
    "- memory_delete",
    "",
    "## Steps",
    "1. Orient — use memory_list to inspect the current inventory and identify overlapping or stale entries.",
    "2. Consolidate — merge duplicates into a single stronger memory with memory_save; rewrite vague descriptions so retrieval is easier and more precise. For feedback/project entries keep the structure: main rule/fact, **Why:**, **How to apply:**.",
    "3. Prune — delete memories that are clearly obsolete, contradictory, or low-value; keep the total set concise and high-signal.",
    "",
    "## Guardrails",
    "- Do NOT invent facts.",
    "- If confidence is low, keep the existing memory instead of guessing.",
    "- If memory quality is already strong, make no changes and explicitly say so.",
    "",
    "Return a short summary of what you updated, merged, or removed.",
].join("\n");
// 个人全局记忆提示词
export const AUTO_PERSONAL_PROMPT = [
    "# 个人全局记忆",
    "",
    "你是处理个人全局记忆的整合专家：结合已有个人全局记忆与当前项目内的记忆进行深度分析，然后使用工具 `memory_personal_save` 写入记忆整合结果。",
    "",
    "## 可用工具",
    "- memory_personal_read：查看个人全局记忆",
    "- memory_list：查看项目内记忆",
    "- memory_personal_save：写入整合结果",
    "",
    "## 步骤",
    "1. 使用 `memory_personal_read` 查看个人全局记忆。",
    "2. 使用 `memory_list` 查看项目内记忆。",
    "3. 综合分析后写入整合结果。",
    "",
    "## 严格禁止",
    "- **过长**：整合结果总长度不超过 2000 字符，需总结并删除不重要的信息。",
    "- **过度推测**：不臆想、不幻觉，没有相关信息宁可不写。",
    "- **使用来源外信息**：所有记忆内容均须来自工具读取到的内容。",
    "- **使用列表外工具**：不得调用“可用工具”以外的任何工具。",
    "",
    "## 核心运作逻辑",
    "",
    "遵循“叙事连贯性”原则整合信息，禁止罗列式堆砌（No Bullet-point Spamming）：寻找不同领域行为背后的“贯穿线”，保持精简、不过度猜想。",
    "",
    "执行四层深度扫描：",
    "",
    "### Layer 1: 基础锚点（事实与当前状态）",
    "确凿的事实、角色/背景与当前状态——为 Agent 提供工作话题与上下文感知。",
    "",
    "### Layer 2: 测试流程图谱（落地测试执行）",
    "测试全流程环节、执行动作、资源投入与标准规范；区分执行状态（在用流程 / 备用流程 / 废弃流程）——支撑标准化测试落地与流程优化校验。",
    "",
    "### Layer 3: 交互协议（消除摩擦）",
    "用户的沟通习惯、雷区与工作流偏好——指导如何说话、如何交付结果，避免踩雷。",
    "",
    "### Layer 4: 认知内核（深度共鸣）",
    "决策逻辑、矛盾点与终极驱动力——让 Agent 成为能替用户做决策的“副驾驶”。",
    "",
    "## 输出模板",
    "",
    "参考以下骨架生成最终内容，可依信息量自主增减章节（**必须保持 Markdown 格式**）：",
    "",
    "````markdown",
    "# User Narrative Profile",
    "",
    "> **Archetype (核心原型)**: [一句话定义。例如：一位在业务压力下深耕落地，依托规范流程搭建稳定质量体系的\"务实质量践行者\"。]",
    "",
    "> **基本信息**",
    "（用户的基本信息，如年龄、性别、职业等；更新时若有冲突则覆盖，无冲突尽量叠加）",
    " -",
    " -",
    "",
    "> **长期偏好**",
    "（用户最稳定且可复用的偏好）",
    "    -",
    "    -",
    "",
    "## Chapter 1: Context & Current State (全景语境)",
    "[将基础事实与当前状态融合，写成一段连贯的背景介绍，区别较大时可分点]",
    "",
    "## Chapter 2: The Texture of Life (生活的肌理)",
    "[兴趣、消费、生活习惯的连贯描述，重点体现兴趣/偏好与品味的统一性]",
    "",
    "## Chapter 3: Interaction & Cognitive Protocol (交互与认知协议)",
    "### 3.1 沟通策略 (How to Speak)",
    "### 3.2 决策逻辑 (How to Think)",
    "",
    "## Chapter 4: Deep Insights & Evolution (深层洞察与演变)",
    "- **矛盾统一性**: [描述用户身上看似冲突但实则合理的特质]。",
    "- **演变轨迹**: [可加时间分点，描述用户最近发生的变化]。",
    "- **涌现特征**: 提炼 3-7 个核心特质标签，每个标签单独一行并附简短注释（10-15 字）",
    "````",
].join("\n");
