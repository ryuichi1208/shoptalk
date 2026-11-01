# 観測とAPI

## ログ

```bash
kubectl --kubeconfig .kubeconfig -n shoptalk logs deployment/shoptalk-api -f
kubectl --kubeconfig .kubeconfig -n shoptalk logs deployment/shoptalk-ai -f
```

両サービスはJSONを標準出力へ送ります。APIの応答と画面に表示される `requestId` を使って照合できます。これは相関IDであり、OpenTelemetryの分散トレースを実装したものではありません。

| イベント | 意味 |
| --- | --- |
| `config_changed` | 演習・対処の設定変更 |
| `ai_attempt_failed` | 試行単位のタイムアウト・依存先の失敗 |
| `chat_completed` | 利用者への応答結果と時間 |
| `record_completed` | 応答後の受付記録の完了 |
| `ai_completed` | 模擬AI側の処理完了。呼び出し元の切断状態も記録 |

## メトリクス

APIと模擬AIの `/metrics` はPrometheusのテキスト形式を返します。Deploymentにはスクレイプ用annotationを付けていますが、Prometheus側にannotationを読む収集設定が必要です。Prometheus OperatorのServiceMonitorは含めていません。

| 指標 | 用途 |
| --- | --- |
| `shoptalk_chat_requests_total{tenant,outcome}` | 通常成功・縮退・失敗・受付制限を区別 |
| `shoptalk_chat_duration_seconds` | 受付制限を含む応答時間ヒストグラム |
| `shoptalk_ai_attempts_total{tenant}` | APIから模擬AIへの試行回数 |
| `shoptalk_ai_timeouts_total{tenant}` | API側の制限時間超過 |
| `shoptalk_ai_errors_total{tenant}` | API側の通信失敗・依存先のエラー |
| `shoptalk_inflight` | APIで実行中の要求 |
| `shoptalk_queue_depth` | 後続処理を待つ受付記録 |
| `shoptalk_recorded` | 処理済み受付記録の累計カウンタ |
| `shoptalk_queue_capacity` | キューの上限 |
| `shoptalk_ai_active` | 模擬AI側で実行中の要求 |
| `shoptalk_ai_received_total` | 模擬AI側で受け取った認証済みの要求 |
| `shoptalk_ai_failed_total` | 模擬AIが503を返した要求 |

最後の3つは模擬AIのエンドポイントにあります。模擬AIだけを確認するには次のポートフォワードを使います。

```bash
kubectl --kubeconfig .kubeconfig -n shoptalk port-forward svc/shoptalk-ai 8081:8081
curl http://localhost:8081/metrics
```

Prometheusを別途接続した場合、通常の機能を提供できた割合は、たとえば次の式で確認できます。縮退応答は分子に含めません。SLOの目標値や評価期間は、この演習では固定していません。

```promql
sum by (tenant) (rate(shoptalk_chat_requests_total{outcome="success"}[5m]))
/
sum by (tenant) (rate(shoptalk_chat_requests_total[5m]))
```

応答時間のp95は次の式です。画面のp95は直近100要求の標本から計算するため、5分のヒストグラムから求める値とは一致しません。

```promql
histogram_quantile(0.95, sum by (tenant, le) (rate(shoptalk_chat_duration_seconds_bucket[5m])))
```

## API

| メソッド・パス | 内容 |
| --- | --- |
| `GET /` | チャット画面 |
| `GET /lab` | 演習画面 |
| `POST /api/chat` | `tenant` と `message` をJSONで送信 |
| `GET /api/status` | 店舗別指標、設定、直近のイベント・完了記録 |
| `POST /api/config` | Bearer認証で演習・対処設定を部分更新 |
| `GET /metrics` | Prometheus形式の指標 |
| `GET /healthz`、`GET /readyz` | プロセスの状態 |

`POST /api/chat` の例です。

```bash
curl http://localhost:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"harbor","message":"配送先を変更したいです。"}'
```

通常応答はHTTP 200、縮退応答もHTTP 200です。`outcome` で `success` と `fallback` を区別します。通常応答の `recordStatus: pending` は後続処理が未完了であることを表します。

入力不正は400または415、上限を超える本文は413、受付制限は503、AIから有効な回答を得られなかった場合は504です。この教材では依存先503の再試行失敗も504へまとめています。実サービスではエラーの意味に応じた応答設計が必要です。

`POST /api/config` で指定できるキーは次の5つです。

```json
{
  "scenario": "normal",
  "retries": 2,
  "timeoutMs": 1000,
  "fallback": false,
  "maxInflight": 8
}
```

`scenario` は `normal`、`tenant-latency`、`ai-latency`、`retry-storm`、`queue-backlog` のいずれかです。範囲外の設定は400、トークンが不正な場合は401です。
