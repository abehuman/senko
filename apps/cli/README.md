# `@senkocode/cli`

日本語インターフェースと設定可能なOpenAI互換エンドポイントに対応した、Senkoターミナルコーディングエージェントです。

```sh
npm install --global @senkocode/cli
export SENKO_BASE_URL=https://api.example.com/v1
export SENKO_API_KEY=your-key
senko --model your-model
```

Senko APIはまだ利用できません。Senkoは`https://api.senkocode.com/v1`を既定のAPIルートとして使用しますが、現時点では
`--base-url`、`SENKO_BASE_URL`、またはXDG設定ファイルの`baseUrl`で利用するOpenAI互換APIを指定してください。

Senkoは、サンドボックスや承認画面を介さずにコーディングツールを自動実行します。設定、リソース、セッションの
詳細は[リポジトリのREADME](https://github.com/abehuman/senko#readme)を参照してください。

CLI自体は無料です。外部APIの利用料金は各プロバイダーの契約に従います。

長いセッションはコンテキスト上限へ達する前に自動圧縮されます。進行状況はTUIまたはstderrへ出力するため、
printモードのアシスタント標準出力には混ざりません。対話型TUIのコマンドメニューは`/`または日本語入力中の
全角`；`で開け、全角英字でも候補を絞り込めます。確定後のコマンド名は半角英字です。`/compact`で手動圧縮でき、
圧縮中に`Escape`か`Ctrl+C`を押すとキャンセルできます。

表示言語は日本語（`ja`）と英語（`en`）に対応しています。`--language`、`SENKO_LANGUAGE`、またはXDG設定
ファイルの`language`で指定できます。明示的な指定がない場合は端末のロケールから検出し、対応言語がなければ
英語を使用します。
