# `@senkocode/api`

Senkoの推論APIを提供するHono製Cloudflare Workerです。認証付きの`GET /v1/models`、
`POST /v1/chat/completions`、`POST /v1/responses`を公開し、許可したモデルだけをサーバー設定の
OpenAI互換LLM APIへ転送します。`fast`は`SENKO_FAST_MODEL`へ解決されます。実装中の公開・管理contractは
認証不要の`GET /openapi.json`からOpenAPI 3.1として取得できます。

## ローカル開発

リポジトリルートで依存関係をインストールし、設定例をコピーして値を置き換えます。

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm dev:api
```

`http://localhost:8787/health`で起動を確認でき、`http://localhost:8787/openapi.json`でAPI仕様を取得できます。
`.dev.vars`はGit管理されません。

## Worker設定

| Binding | 種別 | 用途 |
| --- | --- | --- |
| `SENKO_AUTH_MODE` | text | `database`（通常運用）または`bootstrap`（移行・ローカル専用） |
| `SENKO_DATABASE_URL` | secret | Worker専用DBユーザーでRailway PostgreSQLへ直接接続するURL |
| `SENKO_API_KEY_HASH_SECRET_V1` | secret | version 1顧客APIキーのHMACを作る32 bytes以上のランダムsecret |
| `SENKO_ADMIN_TOKEN` | secret | account作成・APIキー発行/失効用の32 bytes以上の管理Bearer token |
| `SENKO_API_KEYS` | secret | `bootstrap` modeだけで使うクライアントBearerキー。カンマまたは改行区切り |
| `LLM_API_KEY` | secret | Senko APIから呼び出すLLM APIのBearerキー |
| `LLM_API_BASE_URL` | text | Senko APIから呼び出すLLM APIのURL。`/v1`まで含める |
| `SENKO_PROVIDER_ROUTES` | text | modelごとの明示的なprovider route定義。設定時はlegacyの`LLM_API_*`を置き換える |
| `SENKO_FAST_MODEL` | text | `fast`が解決されるモデルID |
| `SENKO_MODELS` | text | 許可モデル定義のJSON配列 |
| `SENKO_INFERENCE_ENABLED` | text | 必須のemergency kill switch。`true`で推論を有効化し、`false`で即時停止。未設定・空・その他の値は503でfail closed |
| `SENKO_ADMISSION` | Durable Object | 推論リクエストの全体・APIキー別上限を一元管理 |
| `SENKO_PROVIDER_POOLS` | Durable Object | stable routeごとのprovider RPM・TPM・同時実行数・circuitを管理 |

機械可読なbinding分類とenvironment分離・rotation境界は
[`config-inventory.json`](config-inventory.json)と
[`docs/api-deployment-configuration.md`](../../docs/api-deployment-configuration.md)にあります。リポジトリにはbinding名と
要件だけを置き、secret値やenvironment固有の設定値は保存しません。

外部providerを通る1回限定のcontent-free確認は
[`docs/api-provider-canary.md`](../../docs/api-provider-canary.md)の手順を使います。script追加はremote実行やschedule設定の
承認を意味しません。

各モデル定義には`id`、`context_window`、`max_output_tokens`、`supported_protocols`、
`input_modalities`、`reasoning`が必要です。`created`と`owned_by`は省略でき、それぞれ`0`と`senko`になります。
database認証で推論するモデルには、さらに`pricing.version`、3文字の`pricing.currency`、
`pricing.input_microunits_per_million_tokens`、`pricing.output_microunits_per_million_tokens`が必要です。
bootstrap modeではpricingを省略できます。価格やaccount上限を仮の既定値へfallbackせず、未設定時はproviderへ送る前に
`503`でfail closedします。
設定不備は、修正すべきbinding名を含む`503 configuration_error`として返します。
`SENKO_ADMISSION`のbindingとSQLite migrationは`wrangler.jsonc`で定義済みです。

複数routeを使う場合、`SENKO_PROVIDER_ROUTES`へ次のようなJSON配列を設定します。各routeは安定した`id`、
コードで送信先originと専用secret名を固定した`destination`、小さい値を優先する`priority`、provider契約上限を
明示する`capacity`、対応protocol、
Senko catalog modelからupstream modelへの`models` mappingを持ちます。候補はpriority、同値ならroute ID順に
決定的に選択されます。候補routeのsecretが一つでも欠ける場合は、そのrouteを黙って飛ばさず`503`でfail closedします。

```json
[
  {
    "id": "singapore-primary",
    "destination": "openai",
    "priority": 10,
    "capacity": {
      "max_concurrent_requests": 10,
      "requests_per_minute": 120,
      "tokens_per_minute": 200000
    },
    "supported_protocols": ["openai-completions", "openai-responses"],
    "models": { "senko/coding-model": "provider/coding-model" }
  }
]
```

`destination`は`openai`、`openrouter`、`deepseek`のいずれかで、それぞれ送信先とsecret名が
`https://api.openai.com/v1` / `SENKO_PROVIDER_KEY_OPENAI`、
`https://openrouter.ai/api/v1` / `SENKO_PROVIDER_KEY_OPENROUTER`、
`https://api.deepseek.com` / `SENKO_PROVIDER_KEY_DEEPSEEK`へ固定されます。route JSONから任意のWorker bindingや
任意originは指定できません。必要なキーは対応するWorker secretとして登録します。`capacity`はrouteごとのRPM、TPM、
同時実行数を表し、`SENKO_PROVIDER_POOLS`のroute別Durable Objectが顧客quotaとは別にlease管理します。上限到達または
circuit open中のrouteはproviderへ送信する前に飛ばし、次の候補を選択します。

`SENKO_PROVIDER_ROUTES`未設定時だけ、bootstrap modeのlocal/移行用単一routeとして`LLM_API_BASE_URL`と
`LLM_API_KEY`を使用します。database modeではcapacity管理を迂回するlegacy routeを拒否します。providerへの通信開始後は
別routeへ再送せず、stream開始後のsilent retryも行いません。

`database` modeは`SENKO_DATABASE_URL`が使えないと`503 identity_unavailable`になり、
`SENKO_API_KEYS`へ自動fallbackしません。`SENKO_DATABASE_URL`はmigration用の`DATABASE_PUBLIC_URL`とは別の
Worker runtime credentialです。`pg`の`Client`をリクエスト単位で作成・終了し、現時点では共有connection poolを
使いません。Cloudflare WorkersはこのWorkerのcompatibility dateではNode.js compatibilityを標準で有効にし、
`pg`の直接TCP接続をbundleできます。

## PostgreSQL IAM schema

customer identityの正本にはSingapore regionのRailway managed PostgreSQLを使用します。productionと
development/testは同じRailway project/environment内の別Postgres serviceです。開発・テストでは必ず
development/test serviceを明示的に対象にします。

型付きschemaは[`src/db/schema.ts`](src/db/schema.ts)、生成SQLは[`db/migrations`](db/migrations)、運用境界は
[`db/README.md`](db/README.md)にあります。初回migrationはusers、accounts、teams、account/team membership、
account-owned API key、scope、admin audit eventを定義します。追加migrationはaccount/API key usage limits、集計bucket、
immutable provider attempt、append-only ledger eventを定義します。raw API keyは保存しません。

```sh
pnpm --filter @senkocode/api db:generate
pnpm --filter @senkocode/api db:check
```

`0000`から`0005`までの全migrationはdevelopment/test Railway Postgresへ適用・検証済みです。検証はmigrationの
件数・順序・timestamp・SQL hash、table/column/type/nullability、外部キー、check、index、TLSを厳密に照合します。
production DBには適用していません。
Workerの直接接続コードとDB認証は実装済みですが、Cloudflare secret設定・実Workerからの接続確認・専用runtime
DB roleの作成は未実施です。これらの外部変更と今後のmigrationは、対象を確認したうえで別途承認が必要です。

## AccountとAPIキーの管理

管理ルートは通常の顧客APIキーではなく`SENKO_ADMIN_TOKEN`で保護します。これはユーザー認証/管理画面ができるまでの
R0 provisioning境界であり、公開の永続的な管理方式ではありません。

```http
POST /admin/v1/accounts
Authorization: Bearer <SENKO_ADMIN_TOKEN>
Content-Type: application/json

{"name":"Example account","plan_key":"beta"}
```

作成済みaccountのID、name、plan、status、作成・停止時刻は最大100件のcursor paginationで確認できます。
利用量、APIキー、team、監査metadataはこの一覧へ混在させません。

```http
GET /admin/v1/accounts?limit=50&starting_after=<account-id>
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

```http
POST /admin/v1/accounts/<account-id>/api-keys
Authorization: Bearer <SENKO_ADMIN_TOKEN>
Content-Type: application/json

{"name":"Developer CLI","scopes":["models:read","inference:chat","inference:responses"],"expires_at":null}
```

アカウント内で利用主体を分ける場合は、先にteamを作成し、その`id`をAPIキー発行時の`team_id`へ指定します。

```http
POST /admin/v1/accounts/<account-id>/teams
Authorization: Bearer <SENKO_ADMIN_TOKEN>
Content-Type: application/json

{"name":"Platform"}
```

team metadataは最大100件のcursor paginationで一覧でき、team全体を可逆的に停止・復旧できます。

```http
GET /admin/v1/accounts/<account-id>/teams?limit=50&starting_after=<team-id>
Authorization: Bearer <SENKO_ADMIN_TOKEN>

POST /admin/v1/accounts/<account-id>/teams/<team-id>/archive
Authorization: Bearer <SENKO_ADMIN_TOKEN>

POST /admin/v1/accounts/<account-id>/teams/<team-id>/reactivate
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

archive後はteam配下のAPIキーによる新しい認証と、そのteamへのkey発行・rotationが失敗します。APIキー自体は
revokeされないため、teamをreactivateすると期限内かつ未失効のキーは再び利用可能になります。漏えいしたキーは
archiveだけで済ませず、個別にrevokeしてください。accountがactiveでない間はteamをreactivateできません。

発行レスポンスの`key`は`sk-senko-v1-...`形式で、このレスポンスに一度だけ含まれます。DBにはraw keyを保存せず、
公開lookup ID、表示用prefix、version付きHMACだけを保存します。レスポンスは`Cache-Control: no-store`です。

```http
GET /admin/v1/accounts/<account-id>/api-keys?limit=50&starting_after=<key-id>
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

一覧は最大100件のmetadataだけを返し、raw keyやHMACは返しません。`has_more=true`の場合は
`next_starting_after`を次のrequestへ渡します。

```http
POST /admin/v1/accounts/<account-id>/api-keys/<key-id>/rotate
Authorization: Bearer <SENKO_ADMIN_TOKEN>
Content-Type: application/json

{"name":"Developer CLI next"}
```

rotationは元キーのaccount/team、scope、rotation group、既定の期限、設定済みの場合はAPI-key usage limit policyを
transaction内で引き継ぎ、新しいraw keyを一度だけ返します。usage bucketの消費量は新キーへ複製しません。
account usage policy、source key、source key policyの順にlockするため、並行するlimit更新・reservationと同じ
lock順になります。元キーは自動失効しないため、利用側を新キーへ切り替えた後に明示的にrevokeします。

```http
POST /admin/v1/accounts/<account-id>/api-keys/<key-id>/revoke
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

アカウント全体を一時停止・復旧するoperator操作も用意しています。同じ状態への再実行は成功し、重複する監査eventは
作りません。`closed`状態のアカウントはこのR0操作では復旧できません。

```http
POST /admin/v1/accounts/<account-id>/suspend
Authorization: Bearer <SENKO_ADMIN_TOKEN>

POST /admin/v1/accounts/<account-id>/reactivate
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

DB認証はkey、account、任意のteamのstatusと期限を毎回確認するため、key失効・team archive・account停止はtransaction
commit後の新しいリクエストへ直ちに反映されます。すでに認証・provider転送を開始したリクエストを強制終了する操作ではないため、
進行中リクエストの扱いはincident runbookに従います。
`GET /v1/models`は`models:read`、Chat Completionsは`inference:chat`、Responsesは
`inference:responses`を要求します。`last_used_at`更新は応答を止めないbackground処理で、同一Worker isolate内では
15分に一度へまとめます。account/team作成、account/team停止・復旧、key発行・rotation・失効はcontent-freeな監査
eventと同じtransactionで保存します。

高頻度にpollされ得る`GET /v1/models`は、認証成功・失敗を問わず`request_traces`へ保存しません。開始/完了は
content-freeなstructured operational eventだけで観測し、model discovery由来のrequest-trace書き込みrateとretentionを
ゼロに固定します。推論routeの最終envelopeは引き続きcontent-freeなrequest traceとして保存します。

管理操作の証跡はaccount境界付きの最大100件cursor paginationで確認できます。レスポンスはaction、actor type、target、
Senko request ID、時刻だけで、監査metadata、actor user/key ID、request body、secretは返しません。既知のaction、actor、target、
UUID、Senko request ID形式だけをallowlistし、未審査の監査event形式が混ざったpageはfail closedします。

```http
GET /admin/v1/accounts/<account-id>/audit-events?limit=50&starting_after=<audit-event-id>
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

管理者用の`GET /admin/v1/dependency-health`は、R1以降に必要なdatabase認証設定、model pricing、provider route、
identity/usage schema、Admission Durable Object、route別Provider Pool Durable Objectを検査します。
`SENKO_ADMIN_TOKEN`が必要で、レスポンスは`ok` / `failed` / `not_checked`だけを返し、URL、secret、DB error、
provider credentialを公開しません。providerへ推論requestは送らないため、外部providerの可用性は別のbounded canaryで確認します。
identity/usage schemaは必要tableを全件照合するため、一部だけ存在する状態をhealthyとして扱いません。
publicな`GET /health`はWorker processのlivenessだけを示します。

localhost限定を既定にした再現可能なauthentication/admission/streaming/settlement負荷プロファイルは
[`docs/api-load-testing.md`](../../docs/api-load-testing.md)にあります。remote実行はsourceを追加しただけでは許可されず、
承認済みtarget、専用account上限、監視、停止条件が別途必要です。

障害調査では、顧客へ返したSenko request IDを管理者用のbounded lookupへ渡せます。

```http
GET /admin/v1/requests/<req_...>
Authorization: Bearer <SENKO_ADMIN_TOKEN>
```

database modeで認証に成功した顧客API requestは、usage予約の成否と独立してrequest ID、account/key ID、endpoint/method、
最終HTTP status/failure category、時刻だけをbackground保存します。そのため、usage limit未設定など予約前に失敗した
requestも検索できます。未認証trafficはDB書き込みを発生させず構造化eventだけへ記録します。SSEはresponse headers時点
ではなく、terminal/cancel/errorを判定したstream終了時に保存します。background保存直後の短い間はlookupへ反映されて
いない場合があります。
このルートはそのenvelopeと最大16 provider attemptまでのmodel/route、予約、精算ledger metadataだけを返します。
prompt、生成結果、tool内容、Authorization、raw key、key HMACはDB queryにもレスポンスschemaにも含めず、
レスポンスは`Cache-Control: no-store`です。保存期間・削除job、R0 operator tokenから顧客管理roleへの権限分離は未決定です。

## Account usage limitとcost精算

database認証の推論は、providerへ送信する前にaccount単位で最大costを予約します。入力は正規化後JSONのUTF-8 byte数を
token数の保守的上限として見積り、出力はリクエストへ設定した最大token数を使います。成功時はChat Completionsの
終端usage chunkと`[DONE]`、またはResponsesの`response.completed`でprotocol終端を確認できた場合だけ、
`prompt_tokens`/`completion_tokens`または`input_tokens`/`output_tokens`を実績精算します。usage欠損、終端未確認、
timeout、cancel、malformed response、非2xx応答、Worker中断が疑われる場合は予約全量を使用済みにする保守的精算を
行います。Provider adapterが生成前拒否を保証できるまでは、非2xxでも予約を解放しません。

accountごとの上限は管理APIで明示的に設定します。金額は指定通貨のmicrounitで、価格改定後も再現できるよう
policy/pricing versionをreservationへsnapshotします。

```http
PUT /admin/v1/accounts/<account-id>/usage-limits
Authorization: Bearer <SENKO_ADMIN_TOKEN>
Content-Type: application/json

{
  "policy_version": "beta-2026-08",
  "currency": "USD",
  "minute_input_tokens": 100000,
  "minute_output_tokens": 20000,
  "max_request_cost_microunits": 1000000,
  "daily_cost_microunits": 10000000,
  "monthly_cost_microunits": 100000000
}
```

必要なAPIキーだけに、account上限以下の追加上限を設定できます。未設定のキーにはaccount上限だけが適用されます。
通貨がaccountと異なる値、またはaccount上限を超える値は拒否します。

```http
PUT /admin/v1/accounts/<account-id>/api-keys/<key-id>/usage-limits
Authorization: Bearer <SENKO_ADMIN_TOKEN>
Content-Type: application/json

{
  "policy_version": "team-a-2026-08",
  "currency": "USD",
  "minute_input_tokens": 25000,
  "minute_output_tokens": 5000,
  "max_request_cost_microunits": 250000,
  "daily_cost_microunits": 2500000,
  "monthly_cost_microunits": 25000000
}
```

同一accountのreservationはPostgreSQL transaction内でaccount limit/bucketを先に、任意のAPI key limit/bucketを後に
固定順でlockします。APIキーを増やしてもaccount予算は増えず、追加のkey上限も同時に超過できません。終端精算と
期限切れreservationの修復も、予約時にsnapshotしたkey policyの有無に従って両方のbucketを更新します。期限切れの
未精算reservationは5分ごとのCloudflare Cron Triggerでexpiry index付きpending queueからbounded batchを
`FOR UPDATE SKIP LOCKED`でclaimし、1接続・1 transactionで全予約額を保守的に精算します。provider invoiceとの
照合、cache/reasoning別単価、実DBでの競合/load検証は未完了です。

## 安全上限

推論エンドポイントは、APIキーのSHA-256 digestを非秘密の識別子として使い、単一のDurable Objectで次の上限を
全Cloudflare isolateにまたがって適用します。

- リクエスト本文: 1 MiB。超過時は上流へ送らず`413 request_too_large`
- 1リクエストの出力: 16,384 tokensまたはモデル定義の`max_output_tokens`の小さい方。Chat Completionsは`n: 1`
- LLM API応答: 全体8 MiB、SSEイベント1件256 KiB
- LLM API待機時間: response headersまで60秒、ストリーム無通信45秒、リクエスト全体5分
- APIキーごと: 1分あたり20リクエスト、同時実行2件
- アカウントごと: 1分あたり60リクエスト、同時実行6件。APIキーを増やしてもこの上限は増えない
- Worker全体: 1分あたり120リクエスト、同時実行12件

上限超過は`Retry-After`付きの`429 rate_limit_exceeded`です。`x-ratelimit-*`は共有LLM APIアカウントの値を
公開せず、APIキー上限とアカウント・Worker上限を合わせたSenko側の実効残数・resetを返します。応答ストリームの
終了またはキャンセル時に
同時実行leaseを解放します。leaseはリクエストの5分deadlineを越えず、30秒ごとに更新される90秒leaseです。
一時的な更新失敗では5秒後に再試行し、確定したlease消失、または確認済み期限の10秒前までに更新できない場合だけ
実行中のLLM API requestを終了します。旧schemaのactive leaseは既存の`expiresAt`をdeadlineとして保持したまま
移行します。解放は冪等に3回まで試行し、最終失敗はpromptや認証情報を含まない構造化warningとして記録します。
これはaccount別token/spend上限とは別の、R0 WorkerとProvider容量を瞬間的な集中から守る固定安全上限です。
一般公開や大企業向けの最終処理容量ではなく、正式提供前に契約・席数と実測したProvider容量に基づいて調整します。
上限を大幅に引き上げる前にAdmission Controlもaccount単位へ分割します。

## LLM API境界

推論bodyはそのまま転送しません。Chat CompletionsとResponsesごとに許可したtop-level fieldだけを再構築し、
未知fieldは`400 unsupported_parameter`にします。`model`、`n`、出力token上限、`store`はWorkerが決定します。
クライアントの`OpenAI-Organization`、`OpenAI-Project`、`service_tier`、`metadata`、provider側conversation/
response継続、長期prompt-cache retentionは転送しません。`store: true`、`background: true`、provider-hosted
file、hosted tool、選択モデルが対応しない入力modalityも拒否します。toolはクライアント定義の`function`だけを
受け付けます。

成功応答は`application/json`または、`stream: true`の場合は`text/event-stream`だけを受け付けます。JSONは
Chat Completionsのcompleted core schemaと、Responsesのcompleted/incomplete/failed terminalを検証し、SSEはevent単位でJSON、既知event type、
protocol終端を検証してから再emitします。応答のtop-level fieldはallowlistから再構築し、`model`は常にSenkoが
解決したmodel IDへ置き換えます。未知event、不正shape、completed終端のusage欠損、正常終端のないstreamは失敗として扱います。
ProviderからのHTTP redirectは追跡せず、provider credentialや顧客request bodyを登録外originへ転送しません。
正規のincomplete/failed終端はそのまま返し、usageがなければ予約全量を保守的に精算します。
LLM APIの4xx errorは`message`、`type`、`code`、`param`だけを新しいerror envelopeへコピーし、追加の
provider metadataは返しません。ストリーム開始後のtimeout、上限超過、LLM API切断はHTTP errorへ置き換えられない
ため接続を終了し、クライアントはそのrequestを失敗として扱います。
route選択時はrequest ID、Senko model、protocol、attempt番号、route IDだけを構造化eventへ記録します。APIキー、
upstream model、prompt、生成内容は記録しません。

## 構造化運用event

Workerはschema version 1のJSON eventとして、request開始/応答、認証、admission、provider route選択、providerの
response headers・最初のbody byte・streamの最初のoutput delta・完了、usage予約・精算を出力します。
provider headers latency、first-byte latency、stream first-token latency、provider全体durationは別々の整数millisecond値です。
account/keyはraw credentialではなく内部IDだけを使用します。

event builderはevent名、request/internal ID、Senko model、stable route ID、protocol、attempt、HTTP status、分類済み
outcome/failure、timing、予約/実績token・cost数値だけをallowlistから再構築します。prompt、生成文、tool引数/結果、Authorization、
raw API key、provider secret、upstream modelを受け取るfieldはありません。未知field、制御文字を含むstring、不正な数値は
出力前に除去し、log destination障害でrequest処理を失敗させません。Cloudflare側のdashboard、alert、retention、
environment別destination/access controlはまだ運用設定していません。

Cloudflare DashboardまたはWranglerで本番bindingを設定した後、デプロイします。

```sh
pnpm --filter @senkocode/api deploy
```

`wrangler.jsonc`は`workers_dev: false`、`preview_urls: false`を明示し、未承認の公開URLを作りません。
また`keep_vars: true`を指定しているため、このデプロイでDashboardに設定したtext bindingを
削除しません。secretもWrangler deployでは削除されません。`enable_request_signal`も有効にしているため、
Cloudflareが検知したクライアント切断を実行中のLLM API fetchへ伝播します。

このコマンドは外部状態を変更します。実行前に対象CloudflareアカウントとWorker名を確認してください。
API契約と今回のスコープは[`docs/inference-api.md`](../../docs/inference-api.md)を参照してください。

`pnpm check`は通常のunit/injected-provider testに加え、Wrangler `createTestHarness`で実際のworkerd、
`SENKO_ADMISSION` / `SENKO_PROVIDER_POOLS` binding、SQLite migrationを起動します。integration testは同時acquire、
冪等release、期限内renewal、Worker reload後のAdmission active leaseとprovider circuit stateの永続化を確認します。
provider capacity拒否も実bindingで検証し、Cloudflareへdeployしません。
