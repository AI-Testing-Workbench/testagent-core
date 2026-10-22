import { Wildcard } from "@/util/wildcard"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

// testagent_change start - 检测删除命令的辅助函数
function isDeleteCommand(permission: string, pattern: string): boolean {
  // 只针对 bash/shell 权限
  if (permission !== "bash" && permission !== "*") return false
  
  // 匹配删除命令模式（不区分大小写以支持 PowerShell）
  const deletePatterns = [
    /^rm\s/i,           // rm file, rm -rf dir
    /^rmdir\s/i,        // rmdir dir
    /^del\s/i,          // Windows del
    /^erase\s/i,        // Windows erase
    /^remove-item\s/i,  // PowerShell Remove-Item
    /^rd\s/i,           // Windows rd
  ]
  
  return deletePatterns.some(regex => regex.test(pattern.trim()))
}

// 检查规则模式是否针对删除命令
// 区分: "*" 或 "**" (纯通配符) vs "rm *" (明确的删除命令模式)
function isDeleteCommandPattern(pattern: string): boolean {
  const trimmed = pattern.trim()
  
  // 纯通配符模式不算针对删除命令的规则
  if (trimmed === "*" || trimmed === "**") return false
  
  // 检查模式是否以删除命令开头（不区分大小写）
  // 包括: "rm", "rm *", "rm -rf *", "remove-item **" 等
  const deleteCommandPrefixes = [
    /^rm\s/i,           // rm file, rm -rf *
    /^rm$/i,            // 精确匹配 "rm"
    /^rmdir\s/i,
    /^rmdir$/i,
    /^del\s/i,
    /^del$/i,
    /^erase\s/i,
    /^erase$/i,
    /^remove-item\s/i,
    /^remove-item$/i,
    /^rd\s/i,
    /^rd$/i,
  ]
  
  return deleteCommandPrefixes.some(regex => regex.test(trimmed))
}

// 检查规则模式是否匹配删除命令（考虑大小写不敏感）
function matchesDeletePattern(command: string, rulePattern: string): boolean {
  // 获取命令的前缀（删除命令部分）
  const commandLower = command.toLowerCase().trim()
  const ruleLower = rulePattern.toLowerCase().trim()
  
  // 如果规则模式以删除命令开头，使用 Wildcard 匹配（但转为小写）
  if (isDeleteCommandPattern(rulePattern)) {
    return Wildcard.match(commandLower, ruleLower)
  }
  
  return false
}
// testagent_change end

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  
  // testagent_change start - 对删除命令强制询问，除非有明确针对删除命令的规则
  if (isDeleteCommand(permission, pattern)) {
    // 对于删除命令，需要找到所有匹配的规则
    const matchingRules = rules.filter(
      (rule) => 
        Wildcard.match(permission, rule.permission) && 
        (Wildcard.match(pattern, rule.pattern) || matchesDeletePattern(pattern, rule.pattern))
    )
    
    if (matchingRules.length === 0) {
      // 没有匹配规则，强制询问
      return { action: "ask", permission, pattern }
    }
    
    // 优先级规则：
    // 1. 明确的删除命令规则（如 "rm *", "rm **"）优先于通配符规则（"*", "**"）
    // 2. 在同级别中，后面的规则覆盖前面的规则
    // 3. deny 规则：只有通配符 deny 才生效，删除命令 deny 规则视为无效（因为已经是删除命令）
    
    // 将规则分为两组：删除命令规则 和 通配符规则
    const deleteCommandRules: typeof matchingRules = []
    const wildcardRules: typeof matchingRules = []
    
    for (const rule of matchingRules) {
      if (isDeleteCommandPattern(rule.pattern)) {
        deleteCommandRules.push(rule)
      } else {
        wildcardRules.push(rule)
      }
    }
    
    // 优先处理删除命令规则（更具体）
    for (let i = deleteCommandRules.length - 1; i >= 0; i--) {
      const rule = deleteCommandRules[i]
      
      // 删除命令规则：allow 生效，deny 也生效
      if (rule.action === "allow" || rule.action === "deny") {
        // 但通配符权限不生效
        if (rule.permission === "*") {
          continue
        }
        return rule
      }
    }
    
    // 如果没有有效的删除命令规则，检查通配符规则
    for (let i = wildcardRules.length - 1; i >= 0; i--) {
      const rule = wildcardRules[i]
      
      // 通配符规则：只有 deny 生效，allow 不生效
      if (rule.action === "deny") {
        return rule
      }
    }
    
    // 所有匹配规则都被忽略或都是 ask，强制询问
    return { action: "ask", permission, pattern }
  }
  // testagent_change end
  
  return match ?? { action: "ask", permission, pattern: "*" }
}
