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

各モデル定義には`id`、`context_window`、`max_output_tokens`、`supported_protocols`、
`input_modalities`、`reasoning`が必要です。`created`と`owned_by`は省略でき、それぞれ`0`と`senko`になります。
設定不備は、修正すべきbinding名を含む`503 configuration_error`として返します。

Cloudflare DashboardまたはWranglerで本番bindingを設定した後、デプロイします。

```sh
pnpm --filter @senkocode/api deploy
```

このコマンドは外部状態を変更します。実行前に対象CloudflareアカウントとWorker名を確認してください。
API契約と今回のスコープは[`docs/inference-api.md`](../../docs/inference-api.md)を参照してください。
