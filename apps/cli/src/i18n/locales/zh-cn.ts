import type { Formatters } from "../types.js";
import type { Messages } from "./en.js";

export function createSimplifiedChineseMessages(formatters: Formatters) {
	return {
		apiEmpty: () => "API不能为空。",
		apiKeyRequired: () => "非回环推理端点需要设置SENKO_API_KEY。",
		apiUnsupported: () => 'SENKO_API/--api必须是"openai-completions"或"openai-responses"。',
		autoCompactedAfter: ({ after, before }) =>
			`已自动压缩上下文：${formatters.number(before)} → 约${formatters.number(after)}个词元。`,
		autoCompactedBefore: ({ before }) => `已自动压缩上下文（压缩前为${formatters.number(before)}个词元）。`,
		autoCompactionCancelled: () => "已取消自动压缩上下文。",
		autoCompactionFailed: () => "自动压缩上下文失败。",
		autoCompactionFailedWithDetail: ({ message }) => `自动压缩上下文失败：${message}`,
		autoCompactionOverflow: () => "已达到上下文上限；正在自动压缩后重试…",
		autoCompactionThreshold: () => "正在上限前自动压缩上下文…",
		baseUrlAbsolute: () => "配置的基础URL必须是绝对HTTP或HTTPS URL。",
		baseUrlHttp: () => "配置的基础URL必须使用HTTP或HTTPS。",
		baseUrlParts: () => "配置的基础URL不能包含凭据、查询参数或片段。",
		cliUnexpectedError: ({ message }) => `senko：意外错误：${message}`,
		cliUsageHint: () => "运行“senko --help”查看用法。",
		commandCompactDescription: () => "压缩当前会话的上下文",
		commandExitDescription: () => "退出Senko",
		commandModelDescription: () => "更改模型和推理强度",
		commandNewDescription: () => "开始新会话",
		commandPlanDescription: () => "在编辑模式和计划模式之间切换",
		commandResumeDescription: () => "恢复已保存的会话",
		commandUsage: ({ command }) => `用法：${command}`,
		compactedAfter: ({ after, before }) =>
			`已压缩上下文：${formatters.number(before)} → 约${formatters.number(after)}个词元。`,
		compactedBefore: ({ before }) => `已压缩上下文（压缩前为${formatters.number(before)}个词元）。`,
		compactingContext: () => "正在压缩上下文…",
		compactionCancelled: () => "已取消压缩上下文。",
		compactionFailed: ({ message }) => `压缩上下文失败：${message}`,
		configBoolean: ({ field, path }) => `配置项“${field}”（${path}）必须是布尔值。`,
		configContextWindow: ({ path, tokens }) =>
			`${path}中的contextWindow必须大于maxOutputTokens与${formatters.number(tokens)}个安全词元之和。`,
		configNoApiKeys: ({ path }) => `${path}中不允许保存API密钥；请使用SENKO_API_KEY。`,
		configNotObject: ({ path }) => `${path}中的配置必须是JSON对象。`,
		configParse: ({ path }) => `无法解析${path}中的配置。`,
		configPositiveInteger: ({ field, path }) => `配置项“${field}”（${path}）必须是正整数。`,
		configRead: ({ path }) => `无法读取${path}中的配置。`,
		configString: ({ field, path }) => `配置项“${field}”（${path}）必须是字符串。`,
		configUnknownField: ({ field, path }) => `${path}中存在未知配置项“${field}”。`,
		configValueEmpty: ({ name }) => `${name}不能为空。`,
		contextStillTooLarge: () =>
			"上下文已压缩，但待处理的提示仍超过安全上下文容量。请缩短提示或配置更大的contextWindow。",
		diagnosticCollision: () => "冲突",
		diagnosticError: () => "错误",
		diagnosticWarning: () => "警告",
		featureNotBuilt: () => "此功能尚未实现。",
		footerCompacting: ({ model, session }) => `压缩中 · Esc/Ctrl+C中止 · ${model} · ${session}`,
		footerWorking: ({ model, session }) => `处理中 · Esc/Ctrl+C中止 · ${model} · ${session}`,
		headerTagline: () => "高速编程智能体",
		helpText: () => `Senko — 高速终端编程智能体

用法：
  senko [选项] [初始提示]
  senko sessions

选项：
  -p, --print                 输出一个回复后退出
  -c, --continue              继续此目录中最新的会话
  -r, --resume <session-id>   通过ID或唯一ID前缀恢复会话
      --no-session            仅在内存中保留会话
      --base-url <url>        OpenAI兼容API根地址（通常以/v1结尾）
      --model <id>            模型ID（默认值：fast）
      --api <protocol>        openai-completions或openai-responses
      --language <locale>     界面语言：en、zh-CN、zh-TW或ja
  -h, --help                  显示帮助
  -v, --version               显示版本

环境变量：
  SENKO_BASE_URL              API根地址；Senko服务上线前必须设置
  SENKO_API_KEY               Bearer密钥；回环端点以外必须设置
  SENKO_MODEL                 模型ID
  SENKO_API                   API协议（默认值：openai-completions）
  SENKO_LANGUAGE              界面语言；未设置时从终端区域设置中检测

安全性：
  Senko会在没有沙箱的情况下自动运行read、write、edit和shell工具。
`,
		inferenceEndpointMissing: ({ path }) =>
			`未配置推理端点。请设置SENKO_BASE_URL、传入--base-url，或在${path}中添加baseUrl。`,
		inferenceFailed: () => "推理请求失败。",
		interactiveTtyRequired: () => "交互模式需要TTY；重定向输出时请使用--print。",
		labelError: () => "错误",
		labelThinking: () => "思考",
		labelThinkingActive: () => "思考中…",
		labelTool: () => "工具",
		labelYou: () => "你",
		languageUnsupported: ({ value }) => `不支持语言“${value}”。请使用en、zh-CN、zh-TW或ja。`,
		listSessionsFailed: ({ message }) => `无法列出已保存的会话：${message}`,
		maxOutputTokensMinimum: ({ path }) => `${path}中的maxOutputTokens必须至少为2。`,
		modelRegistrationFailed: ({ model }) => `无法注册模型“${model}”。`,
		newSessionFailed: ({ message }) => `senko：无法开始新会话：${message}`,
		noSavedSessions: () => "此目录中没有已保存的会话。",
		printPromptRequired: () => "打印模式需要提示或非空的管道标准输入。",
		resumeDisabledNoSession: () => "使用--no-session时无法恢复已保存的会话。",
		resumeHint: () => "↑/↓ 选择 · Enter 恢复 · Esc 取消",
		resumeSelectedFailed: ({ message }) => `senko：无法恢复所选会话：${message}`,
		resumeTitle: () => "恢复会话",
		retryingRequest: () => "正在重试请求。",
		sessionAmbiguous: ({ id }) => `会话ID前缀“${id}”对应多个会话；请提供更多字符。`,
		sessionEmpty: () => "（空会话）",
		sessionMessages: ({ count }) => `${count}条消息`,
		sessionNotFound: ({ cwd, id }) => `${cwd}中没有与“${id}”匹配的会话。`,
		sessionsNone: () => "此目录中没有会话。",
		toolFailed: () => "工具失败",
		toolFinished: () => "工具完成",
		usageContinueResume: () => "--continue和--resume不能同时使用。",
		usageMissingOptionValue: ({ option }) => `选项“${option}”需要一个值。`,
		usageNoSessionResume: () => "--no-session不能与--continue或--resume同时使用。",
		usageOptionTakesNoValue: ({ option }) => `选项“${option}”不接受值。`,
		usageSessionOptions: () => "会话运行选项不能与sessions命令一起使用。",
		usageSessionsPositionals: () => "sessions命令不接受位置参数。",
		usageUnknownOption: ({ option }) => `未知选项“${option}”。`,
	} satisfies Messages;
}
