import type { Formatters } from "../types.js";
import type { Messages } from "./en.js";

export function createJapaneseMessages(formatters: Formatters) {
	return {
		apiEmpty: () => "APIを空にすることはできません。",
		apiKeyRequired: () => "ループバック以外の推論エンドポイントではSENKO_API_KEYが必要です。",
		apiUnsupported: () => 'SENKO_API/--apiには"openai-completions"または"openai-responses"を指定してください。',
		autoCompactedAfter: ({ after, before }) =>
			`コンテキストを自動圧縮しました: ${formatters.number(before)} → 約${formatters.number(after)}トークン。`,
		autoCompactedBefore: ({ before }) =>
			`コンテキストを自動圧縮しました（圧縮前: ${formatters.number(before)}トークン）。`,
		autoCompactionCancelled: () => "コンテキストの自動圧縮をキャンセルしました。",
		autoCompactionFailed: () => "コンテキストの自動圧縮に失敗しました。",
		autoCompactionFailedWithDetail: ({ message }) => `コンテキストの自動圧縮に失敗しました: ${message}`,
		autoCompactionOverflow: () => "コンテキスト上限に達したため、再試行の前に自動圧縮しています…",
		autoCompactionThreshold: () => "上限に達する前にコンテキストを自動圧縮しています…",
		baseUrlAbsolute: () => "設定するベースURLは絶対HTTP URLまたはHTTPS URLである必要があります。",
		baseUrlHttp: () => "設定するベースURLにはHTTPまたはHTTPSを使用してください。",
		baseUrlParts: () => "設定するベースURLに認証情報、クエリ、フラグメントを含めることはできません。",
		cliUnexpectedError: ({ message }) => `senko: 予期しないエラー: ${message}`,
		cliUsageHint: () => "使い方は「senko --help」で確認できます。",
		commandCompactDescription: () => "現在のセッションのコンテキストを圧縮",
		commandExitDescription: () => "Senkoを終了",
		commandModelDescription: () => "モデルと推論強度を変更",
		commandNewDescription: () => "新しいセッションを開始",
		commandPlanDescription: () => "編集モードとプランモードを切り替え",
		commandResumeDescription: () => "保存済みセッションを再開",
		commandUsage: ({ command }) => `使い方: ${command}`,
		compactedAfter: ({ after, before }) =>
			`コンテキストを圧縮しました: ${formatters.number(before)} → 約${formatters.number(after)}トークン。`,
		compactedBefore: ({ before }) => `コンテキストを圧縮しました（圧縮前: ${formatters.number(before)}トークン）。`,
		compactingContext: () => "コンテキストを圧縮しています…",
		compactionCancelled: () => "コンテキストの圧縮をキャンセルしました。",
		compactionFailed: ({ message }) => `コンテキストの圧縮に失敗しました: ${message}`,
		configBoolean: ({ field, path }) => `設定項目「${field}」（${path}）には真偽値を指定してください。`,
		configContextWindow: ({ path, tokens }) =>
			`${path}のcontextWindowは、maxOutputTokensと${formatters.number(tokens)}安全トークンの合計より大きくしてください。`,
		configNoApiKeys: ({ path }) => `${path}にAPIキーは保存できません。SENKO_API_KEYを使用してください。`,
		configNotObject: ({ path }) => `${path}の設定はJSONオブジェクトである必要があります。`,
		configParse: ({ path }) => `${path}の設定を解析できませんでした。`,
		configPositiveInteger: ({ field, path }) => `設定項目「${field}」（${path}）には正の整数を指定してください。`,
		configRead: ({ path }) => `${path}の設定を読み込めませんでした。`,
		configString: ({ field, path }) => `設定項目「${field}」（${path}）には文字列を指定してください。`,
		configUnknownField: ({ field, path }) => `${path}に不明な設定項目「${field}」があります。`,
		configValueEmpty: ({ name }) => `${name}を空にすることはできません。`,
		contextStillTooLarge: () =>
			"コンテキストを圧縮しましたが、保留中のプロンプトが安全なコンテキスト容量を超えています。プロンプトを短くするか、contextWindowを大きくしてください。",
		diagnosticCollision: () => "競合",
		diagnosticError: () => "エラー",
		diagnosticWarning: () => "警告",
		featureNotBuilt: () => "この機能はまだ実装されていません。",
		footerCompacting: ({ model, session }) => `圧縮中 · Esc/Ctrl+Cで中止 · ${model} · ${session}`,
		footerWorking: ({ model, session }) => `作業中 · Esc/Ctrl+Cで中止 · ${model} · ${session}`,
		headerTagline: () => "高速コーディングエージェント",
		helpText: () => `Senko — 高速ターミナルコーディングエージェント

使い方:
  senko [オプション] [最初のプロンプト]
  senko sessions

オプション:
  -p, --print                 応答を1件出力して終了
  -c, --continue              このディレクトリの最新セッションを継続
  -r, --resume <session-id>   IDまたは一意なID接頭辞でセッションを再開
      --no-session            セッションをメモリ内だけに保持
      --base-url <url>        APIルート（既定値: https://api.senkocode.com/v1）
      --model <id>            モデルID（既定値: fast）
      --api <protocol>        openai-completionsまたはopenai-responses
      --language <locale>     表示言語: jaまたはen
  -h, --help                  ヘルプを表示
  -v, --version               バージョンを表示

環境変数:
  SENKO_BASE_URL              APIルートの上書き
  SENKO_API_KEY               Bearerキー。ループバック以外では必須
  SENKO_API                   APIプロトコル（既定値: openai-completions）
  SENKO_LANGUAGE              表示言語。未指定の場合はターミナルのロケールから検出

安全性:
  Senkoはread、write、edit、shellツールをサンドボックスなしで自動実行します。
`,
		inferenceFailed: () => "推論リクエストに失敗しました。",
		interactiveTtyRequired: () =>
			"対話モードにはTTYが必要です。出力をリダイレクトする場合は--printを使用してください。",
		labelError: () => "エラー",
		labelThinking: () => "思考",
		labelThinkingActive: () => "思考中…",
		labelTool: () => "ツール",
		labelYou: () => "あなた",
		languageUnsupported: ({ value }) => `未対応の言語「${value}」です。jaまたはenを指定してください。`,
		listSessionsFailed: ({ message }) => `保存済みセッションの一覧を取得できませんでした: ${message}`,
		maxOutputTokensMinimum: ({ path }) => `${path}のmaxOutputTokensは2以上にしてください。`,
		modelRegistrationFailed: ({ model }) => `モデル「${model}」を登録できませんでした。`,
		newSessionFailed: ({ message }) => `senko: 新しいセッションを開始できませんでした: ${message}`,
		noSavedSessions: () => "このディレクトリに保存済みセッションはありません。",
		printPromptRequired: () => "出力モードにはプロンプトまたは空でない標準入力が必要です。",
		resumeDisabledNoSession: () => "--no-sessionでは保存済みセッションを再開できません。",
		resumeHint: () => "↑/↓ 選択 · Enter 再開 · Esc キャンセル",
		resumeSelectedFailed: ({ message }) => `senko: 選択したセッションを再開できませんでした: ${message}`,
		resumeTitle: () => "セッションを再開",
		retryingRequest: () => "リクエストを再試行します。",
		sessionAmbiguous: ({ id }) => `セッションIDの接頭辞「${id}」に複数の候補があります。文字数を増やしてください。`,
		sessionEmpty: () => "（空のセッション）",
		sessionMessages: ({ count }) => `${count}件のメッセージ`,
		sessionNotFound: ({ cwd, id }) => `${cwd}に「${id}」と一致するセッションはありません。`,
		sessionsNone: () => "このディレクトリにセッションはありません。",
		toolFailed: () => "ツール失敗",
		toolFinished: () => "ツール完了",
		usageContinueResume: () => "--continueと--resumeは同時に使用できません。",
		usageMissingOptionValue: ({ option }) => `オプション「${option}」には値が必要です。`,
		usageNoSessionResume: () => "--no-sessionは--continueまたは--resumeと同時に使用できません。",
		usageOptionTakesNoValue: ({ option }) => `オプション「${option}」に値は指定できません。`,
		usageSessionOptions: () => "セッション実行用のオプションはsessionsコマンドでは使用できません。",
		usageSessionsPositionals: () => "sessionsコマンドに位置引数は指定できません。",
		usageUnknownOption: ({ option }) => `不明なオプション「${option}」です。`,
	} satisfies Messages;
}
