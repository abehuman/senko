# `@senkocode/api`

Senkoの推論APIを提供するHono製Cloudflare Workerです。認証付きの`GET /v1/models`、
`POST /v1/chat/completions`、`POST /v1/responses`を公開し、許可したモデルだけをサーバー設定の
OpenAI互換LLM APIへ転送します。`fast`は`SENKO_FAST_MODEL`へ解決されます。

## ローカル開発

リポジトリルートで依存関係をインストールし、設定例をコピーして値を置き換えます。

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm dev:api
```

`http://localhost:8787/health`で起動を確認できます。`.dev.vars`はGit管理されません。

## Worker設定

| Binding | 種別 | 用途 |
| --- | --- | --- |
| `SENKO_API_KEYS` | secret | クライアント用Bearerキー。カンマまたは改行区切り |
| `LLM_API_KEY` | secret | Senko APIから呼び出すLLM APIのBearerキー |
| `LLM_API_BASE_URL` | text | Senko APIから呼び出すLLM APIのURL。`/v1`まで含める |
| `SENKO_FAST_MODEL` | text | `fast`が解決されるモデルID |
| `SENKO_MODELS` | text | 許可モデル定義のJSON配列 |
| `SENKO_ADMISSION` | Durable Object | 推論リクエストの全体・APIキー別上限を一元管理 |

各モデル定義には`id`、`context_window`、`max_output_tokens`、`supported_protocols`、
`input_modalities`、`reasoning`が必要です。`created`と`owned_by`は省略でき、それぞれ`0`と`senko`になります。
設定不備は、修正すべきbinding名を含む`503 configuration_error`として返します。
`SENKO_ADMISSION`のbindingとSQLite migrationは`wrangler.jsonc`で定義済みです。

## PostgreSQL IAM schema

customer identityの正本にはSingapore regionのRailway managed PostgreSQLを使用します。productionと
development/testは同じRailway project/environment内の別Postgres serviceです。開発・テストでは必ず
development/test serviceを明示的に対象にします。

型付きschemaは[`src/db/schema.ts`](src/db/schema.ts)、生成SQLは[`db/migrations`](db/migrations)、運用境界は
[`db/README.md`](db/README.md)にあります。初回migrationはusers、accounts、teams、account/team membership、
account-owned API key、scope、admin audit eventを定義します。raw API keyは保存しません。

```sh
pnpm --filter @senkocode/api db:generate
pnpm --filter @senkocode/api db:check
```

初回migrationはdevelopment/test Railway Postgresへ適用・検証済みです。production DBには適用しておらず、Worker
runtimeもPostgreSQLへ接続していません。現時点の認証は引き続き`SENKO_API_KEYS` bootstrapです。今後の外部DB
migrationも対象serviceを確認したうえで別途承認が必要です。

## 安全上限

推論エンドポイントは、APIキーのSHA-256 digestを非秘密の識別子として使い、単一のDurable Objectで次の上限を
全Cloudflare isolateにまたがって適用します。

- リクエスト本文: 1 MiB。超過時は上流へ送らず`413 request_too_large`
- 1リクエストの出力: 16,384 tokensまたはモデル定義の`max_output_tokens`の小さい方。Chat Completionsは`n: 1`
- LLM API応答: 全体8 MiB、SSEイベント1件256 KiB
- LLM API待機時間: response headersまで60秒、ストリーム無通信45秒、リクエスト全体5分
- APIキーごと: 1分あたり20リクエスト、同時実行2件
- Worker全体: 1分あたり120リクエスト、同時実行12件

上限超過は`Retry-After`付きの`429 rate_limit_exceeded`です。`x-ratelimit-*`は共有LLM APIアカウントの値を
公開せず、Senkoが適用したAPIキー別の上限・残数・resetを返します。応答ストリームの終了またはキャンセル時に
同時実行leaseを解放します。leaseはリクエストの5分deadlineを越えず、30秒ごとに更新される90秒leaseです。
一時的な更新失敗では5秒後に再試行し、確定したlease消失、または確認済み期限の10秒前までに更新できない場合だけ
実行中のLLM API requestを終了します。旧schemaのactive leaseは既存の`expiresAt`をdeadlineとして保持したまま
移行します。解放は冪等に3回まで試行し、最終失敗はpromptや認証情報を含まない構造化warningとして記録します。
これは請求・プラン別quotaとは別の、初期Workerを共有LLM APIキーの無制限利用から守るための固定安全上限です。

## LLM API境界

推論bodyはそのまま転送しません。Chat CompletionsとResponsesごとに許可したtop-level fieldだけを再構築し、
未知fieldは`400 unsupported_parameter`にします。`model`、`n`、出力token上限、`store`はWorkerが決定します。
クライアントの`OpenAI-Organization`、`OpenAI-Project`、`service_tier`、`metadata`、provider側conversation/
response継続、長期prompt-cache retentionは転送しません。`store: true`、`background: true`、provider-hosted
file、hosted tool、選択モデルが対応しない入力modalityも拒否します。toolはクライアント定義の`function`だけを
受け付けます。

成功応答は`application/json`または、`stream: true`の場合は`text/event-stream`だけを受け付けます。
LLM APIの4xx errorは`message`、`type`、`code`、`param`だけを新しいerror envelopeへコピーし、追加の
provider metadataは返しません。ストリーム開始後のtimeout、上限超過、LLM API切断はHTTP errorへ置き換えられない
ため接続を終了し、クライアントはそのrequestを失敗として扱います。

Cloudflare DashboardまたはWranglerで本番bindingを設定した後、デプロイします。

```sh
pnpm --filter @senkocode/api deploy
```

`wrangler.jsonc`は`keep_vars: true`を指定しているため、このデプロイでDashboardに設定したtext bindingを
削除しません。secretもWrangler deployでは削除されません。`enable_request_signal`も有効にしているため、
Cloudflareが検知したクライアント切断を実行中のLLM API fetchへ伝播します。

このコマンドは外部状態を変更します。実行前に対象CloudflareアカウントとWorker名を確認してください。
API契約と今回のスコープは[`docs/inference-api.md`](../../docs/inference-api.md)を参照してください。
