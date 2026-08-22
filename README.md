# Senko

日本語 | [English](README.en.md)

Senkoは、macOSとLinuxのターミナルで動作する無料の日本語対応AIコーディングエージェントです。
[Pi coding-agent SDK](https://github.com/earendil-works/pi)を基盤に、任意のOpenAI互換エンドポイントへ接続できます。

> [!WARNING]
> 現在のSenkoは、ターミナルプロセスと同じホスト権限で`read`、`write`、`edit`、`shell`ツールを自動実行します。
> サンドボックスやツールごとの承認画面はまだありません。信頼できるワークスペースと環境でのみ使用してください。

## インストール

Node.js 22.19.0以上が必要です。対応OSはmacOSとLinuxです。

```sh
npm install --global @senkocode/cli
```

## クイックスタート

Senko APIはまだ利用できません。利用するOpenAI互換APIのURLとAPIキーを指定してください。CLI自体は無料ですが、
外部APIの利用料金は各プロバイダーの契約に従います。

```sh
export SENKO_BASE_URL=https://api.example.com/v1
export SENKO_API_KEY=your-key

senko --model your-model
```

## 使い方

```text
senko [最初のプロンプト]
senko --print <プロンプト>
senko --continue
senko --resume <session-id>
senko sessions
senko --language ja
senko --help
senko --version
```

TTYではない標準入力を渡すと、自動的にprintモードになります。新しいセッションは既定で保存され、
`--no-session`を指定するとメモリ内だけで実行されます。`--continue`は現在のディレクトリで最新のセッションを選択し、
`--resume`は完全なセッションIDまたは一意なID接頭辞を受け付けます。

対話型TUIのコマンドメニューは、`/`または入力欄先頭の全角スペース（`　`）で開けます。全角英字でも候補を絞り込め、
確定後のコマンド名は半角英字になります。`/compact`で現在のコンテキストを手動圧縮できます。`/clear`は新しい
セッションを開始し、`/new`はその別名です。`/resume`は保存済みセッションの選択画面を開きます。`/exit`でSenkoを
終了し、`/quit`はその別名です。`/model`と`/plan`は未実装で、モデルへ送信せずに案内を表示します。

長いセッションはコンテキスト上限へ達する前に自動圧縮されます。TUIでは進行状況を表示し、printモードでは
アシスタントの標準出力に混ぜずstderrへ出力します。手動または自動圧縮中に`Escape`か`Ctrl+C`を押すと
キャンセルできます。

## 設定

設定項目ごとの優先順位は次のとおりです。

| 設定 | 優先順位 |
| --- | --- |
| APIルート | `--base-url` → `SENKO_BASE_URL` → `baseUrl` → `https://api.senkocode.com/v1` |
| APIプロトコル | `--api` → `SENKO_API` → `api` → `openai-completions` |
| モデル | `--model` → `model` → `fast` |
| 表示言語 | `--language` → `SENKO_LANGUAGE` → `language` → OSのロケール検出 → 英語 |
| APIキー | `SENKO_API_KEY`のみ |
| `contextWindow` | 設定ファイル → `32768` |
| `maxOutputTokens` | 設定ファイル → `4096` |
| `reasoning` | 設定ファイル → `false` |

表中の`baseUrl`、`api`、`model`、`language`はXDG設定ファイルのフィールド名です。モデルには環境変数による
上書きはありません。

表示言語は日本語（`ja`）と英語（`en`）に対応しています。明示的な指定がない場合は、`LC_ALL`、
`LC_MESSAGES`、`LANGUAGE`、`LANG`、Node.jsの実行時ロケールの順で検出します。`LANGUAGE`には
コロン区切りの優先言語リストを指定できます。`ja_JP.UTF-8`や`en_US.UTF-8`などのロケール表記にも対応しています。
コマンド名、オプション名、環境変数名、ツールの生出力は表示言語によって変更されません。

機密情報を含まない設定ファイルは`$XDG_CONFIG_HOME/senko/config.json`に置きます。`XDG_CONFIG_HOME`が
未設定の場合は`~/.config/senko/config.json`を使用します。

```json
{
  "language": "ja",
  "api": "openai-completions",
  "model": "fast",
  "contextWindow": 32768,
  "maxOutputTokens": 4096,
  "reasoning": false
}
```

APIキーは`SENKO_API_KEY`からのみ受け付け、設定ファイルから読み込んだりセッションファイルへ保存したりしません。
ループバックエンドポイントでは、APIキーを指定せずに実行できます。`baseUrl`には完全なAPIルートを指定してください。
Senkoは末尾のスラッシュを1つ削除しますが、`/v1`を自動追加しません。

`maxOutputTokens`は2以上である必要があります。また、`contextWindow`は`maxOutputTokens`と4,096トークンの
リクエスト安全領域の合計より大きくする必要があります。

セッションは`$XDG_STATE_HOME/senko/sessions`に保存します。`XDG_STATE_HOME`が未設定の場合は
`~/.local/state/senko/sessions`を使用します。

## エージェントリソース

Senkoの組み込み基本指示は[`apps/cli/src/prompts/base.md`](apps/cli/src/prompts/base.md)にあり、CLIへ同梱されます。
リポジトリルートから作業ディレクトリまでにある`AGENTS.md`の汎用指示も読み込みます。スキルはリポジトリ内の
`.agents/skills/`と`~/.agents/skills/`から検出します。プロジェクト内の`.pi`、`.claude`、`.opencode`、
`.senko`リソースは読み込みません。

## 開発

開発にはpnpm 10.34.1を使用します。

```sh
pnpm install
pnpm build
pnpm test
pnpm dev -- --help
```

```sh
pnpm dev:website
pnpm check
pnpm smoke:pack
pnpm bench
```

開発者向けの詳細は[アーキテクチャ](docs/architecture.md)、[ベンチマーク定義](benchmarks/README.md)、
[リリースガイド](docs/releasing.md)を参照してください。
