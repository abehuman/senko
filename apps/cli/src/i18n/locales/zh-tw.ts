import type { Formatters } from "../types.js";
import type { Messages } from "./en.js";

export function createTraditionalChineseMessages(formatters: Formatters) {
	return {
		apiEmpty: () => "API不可為空。",
		apiKeyRequired: () => "非迴路推論端點需要設定SENKO_API_KEY。",
		apiUnsupported: () => 'SENKO_API/--api必須是"openai-completions"或"openai-responses"。',
		autoCompactedAfter: ({ after, before }) =>
			`已自動壓縮上下文：${formatters.number(before)} → 約${formatters.number(after)}個詞元。`,
		autoCompactedBefore: ({ before }) => `已自動壓縮上下文（壓縮前為${formatters.number(before)}個詞元）。`,
		autoCompactionCancelled: () => "已取消自動壓縮上下文。",
		autoCompactionFailed: () => "自動壓縮上下文失敗。",
		autoCompactionFailedWithDetail: ({ message }) => `自動壓縮上下文失敗：${message}`,
		autoCompactionOverflow: () => "已達到上下文上限；正在自動壓縮後重試…",
		autoCompactionThreshold: () => "正在上限前自動壓縮上下文…",
		baseUrlAbsolute: () => "設定的基礎URL必須是絕對HTTP或HTTPS URL。",
		baseUrlHttp: () => "設定的基礎URL必須使用HTTP或HTTPS。",
		baseUrlParts: () => "設定的基礎URL不可包含認證資訊、查詢參數或片段。",
		cliUnexpectedError: ({ message }) => `senko：未預期的錯誤：${message}`,
		cliUsageHint: () => "執行「senko --help」查看用法。",
		commandCompactDescription: () => "壓縮目前工作階段的上下文",
		commandExitDescription: () => "結束Senko",
		commandModelDescription: () => "變更模型和推論強度",
		commandNewDescription: () => "開始新的工作階段",
		commandPlanDescription: () => "在編輯模式與計畫模式之間切換",
		commandResumeDescription: () => "繼續已儲存的工作階段",
		commandUsage: ({ command }) => `用法：${command}`,
		compactedAfter: ({ after, before }) =>
			`已壓縮上下文：${formatters.number(before)} → 約${formatters.number(after)}個詞元。`,
		compactedBefore: ({ before }) => `已壓縮上下文（壓縮前為${formatters.number(before)}個詞元）。`,
		compactingContext: () => "正在壓縮上下文…",
		compactionCancelled: () => "已取消壓縮上下文。",
		compactionFailed: ({ message }) => `壓縮上下文失敗：${message}`,
		configBoolean: ({ field, path }) => `設定項目「${field}」（${path}）必須是布林值。`,
		configContextWindow: ({ path, tokens }) =>
			`${path}中的contextWindow必須大於maxOutputTokens與${formatters.number(tokens)}個安全詞元之和。`,
		configNoApiKeys: ({ path }) => `${path}中不可儲存API金鑰；請使用SENKO_API_KEY。`,
		configNotObject: ({ path }) => `${path}中的設定必須是JSON物件。`,
		configParse: ({ path }) => `無法剖析${path}中的設定。`,
		configPositiveInteger: ({ field, path }) => `設定項目「${field}」（${path}）必須是正整數。`,
		configRead: ({ path }) => `無法讀取${path}中的設定。`,
		configString: ({ field, path }) => `設定項目「${field}」（${path}）必須是字串。`,
		configUnknownField: ({ field, path }) => `${path}中有未知的設定項目「${field}」。`,
		configValueEmpty: ({ name }) => `${name}不可為空。`,
		contextStillTooLarge: () =>
			"上下文已壓縮，但等候處理的提示仍超過安全上下文容量。請縮短提示或設定更大的contextWindow。",
		diagnosticCollision: () => "衝突",
		diagnosticError: () => "錯誤",
		diagnosticWarning: () => "警告",
		featureNotBuilt: () => "此功能尚未實作。",
		footerCompacting: ({ model, session }) => `壓縮中 · Esc/Ctrl+C中止 · ${model} · ${session}`,
		footerWorking: ({ model, session }) => `處理中 · Esc/Ctrl+C中止 · ${model} · ${session}`,
		headerTagline: () => "高速程式設計代理",
		helpText: () => `Senko — 高速終端機程式設計代理

用法：
  senko [選項] [初始提示]
  senko sessions

選項：
  -p, --print                 輸出一個回覆後結束
  -c, --continue              繼續此目錄中最新的工作階段
  -r, --resume <session-id>   透過ID或唯一ID前綴繼續工作階段
      --no-session            僅在記憶體中保留工作階段
      --base-url <url>        OpenAI相容API根網址（通常以/v1結尾）
      --model <id>            模型ID（預設值：fast）
      --api <protocol>        openai-completions或openai-responses
      --language <locale>     介面語言：en、zh-CN、zh-TW或ja
  -h, --help                  顯示說明
  -v, --version               顯示版本

環境變數：
  SENKO_BASE_URL              API根網址；Senko服務上線前必須設定
  SENKO_API_KEY               Bearer金鑰；迴路端點以外必須設定
  SENKO_API                   API協定（預設值：openai-completions）
  SENKO_LANGUAGE              介面語言；未設定時從終端機地區設定中偵測

安全性：
  Senko會在沒有沙箱的情況下自動執行read、write、edit和shell工具。
`,
		inferenceEndpointMissing: ({ path }) =>
			`尚未設定推論端點。請設定SENKO_BASE_URL、傳入--base-url，或在${path}中加入baseUrl。`,
		inferenceFailed: () => "推論要求失敗。",
		interactiveTtyRequired: () => "互動模式需要TTY；重新導向輸出時請使用--print。",
		labelError: () => "錯誤",
		labelThinking: () => "思考",
		labelThinkingActive: () => "思考中…",
		labelTool: () => "工具",
		labelYou: () => "你",
		languageUnsupported: ({ value }) => `不支援語言「${value}」。請使用en、zh-CN、zh-TW或ja。`,
		listSessionsFailed: ({ message }) => `無法列出已儲存的工作階段：${message}`,
		maxOutputTokensMinimum: ({ path }) => `${path}中的maxOutputTokens必須至少為2。`,
		modelRegistrationFailed: ({ model }) => `無法註冊模型「${model}」。`,
		newSessionFailed: ({ message }) => `senko：無法開始新的工作階段：${message}`,
		noSavedSessions: () => "此目錄中沒有已儲存的工作階段。",
		printPromptRequired: () => "列印模式需要提示或非空的管線標準輸入。",
		resumeDisabledNoSession: () => "使用--no-session時無法繼續已儲存的工作階段。",
		resumeHint: () => "↑/↓ 選擇 · Enter 繼續 · Esc 取消",
		resumeSelectedFailed: ({ message }) => `senko：無法繼續選取的工作階段：${message}`,
		resumeTitle: () => "繼續工作階段",
		retryingRequest: () => "正在重試要求。",
		sessionAmbiguous: ({ id }) => `工作階段ID前綴「${id}」對應多個工作階段；請提供更多字元。`,
		sessionEmpty: () => "（空白工作階段）",
		sessionMessages: ({ count }) => `${count}則訊息`,
		sessionNotFound: ({ cwd, id }) => `${cwd}中沒有與「${id}」相符的工作階段。`,
		sessionsNone: () => "此目錄中沒有工作階段。",
		toolFailed: () => "工具失敗",
		toolFinished: () => "工具完成",
		usageContinueResume: () => "--continue和--resume不可同時使用。",
		usageMissingOptionValue: ({ option }) => `選項「${option}」需要一個值。`,
		usageNoSessionResume: () => "--no-session不可與--continue或--resume同時使用。",
		usageOptionTakesNoValue: ({ option }) => `選項「${option}」不接受值。`,
		usageSessionOptions: () => "工作階段執行選項不可與sessions命令一起使用。",
		usageSessionsPositionals: () => "sessions命令不接受位置引數。",
		usageUnknownOption: ({ option }) => `未知選項「${option}」。`,
	} satisfies Messages;
}
