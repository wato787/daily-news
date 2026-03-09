# Zenn / Qiita 対応の検討

## 現状

- **ソース**: Reddit (r/technology), Hacker News の2つのみ
- **流れ**: `Promise.all` で各 fetch → 1行形式で結合 → Gemini でフィルタ・日本語化 → Discord 通知
- **形式**: 各ソースは `[ソース名] タイトル - URL` の文字列配列を返す

## 1. Zenn の追加

### 取得方法

- **RSS（推奨）**: 公式フィードを利用する
  - トレンド全体: `https://zenn.dev/feed`（最新20件）
  - トピック別: `https://zenn.dev/topics/typescript/feed` など
- 非公式APIは廃止・不安定のため使わない。

### 実装方針

1. **RSS のパース**
   - Cloudflare Workers では **fast-xml-parser** が推奨（Fetch ベースで動く）。`rss-parser` は XHR 依存のため Workers では不向き。
   - 依存追加: `npm i fast-xml-parser`
   - 流れ: `fetch("https://zenn.dev/feed")` → `text()` → XML パース → `rss.channel.item` から `title` と `link` を取得し、既存と同じ `[Zenn] タイトル - URL` 形式で返す。

2. **RSS の構造（Zenn）**
   - `<item>` に `<title>`（CDATA）、`<link>` が含まれる。パース結果は `item.title`、`item.link` で参照可能（fast-xml-parser のオプションで CDATA をテキスト化）。

3. **件数**
   - トレンド feed はデフォルト20件。そのまま使うか、先頭 N 件（例: 10）に絞って HN/Reddit とバランスを取る。

### コード例（イメージ）

```ts
import { XMLParser } from "fast-xml-parser";

async function fetchZenn(limit = 10): Promise<string[]> {
  const res = await fetch("https://zenn.dev/feed");
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  return list.slice(0, limit).map((item: any) =>
    `[Zenn] ${item.title ?? ""} - ${item.link ?? ""}`
  );
}
```

---

## 2. Qiita の追加

### 取得方法（2案）

| 方法 | URL | 特徴 |
|------|-----|------|
| **A. 公式 API** | `GET https://qiita.com/api/v2/items?page=1&per_page=20` | 安定。認証なしで 60 req/h。`query` で絞り込み可。 |
| **B. 非公式トレンド** | `https://qiita-api.vercel.app/api/trend` | トレンド一覧がそのまま取れるが、第三者運用のため長期は要検討。 |

### 推奨: 公式 API（A）

- **エンドポイント**: `https://qiita.com/api/v2/items?page=1&per_page=20`
- **オプション**:
  - 人気寄りにしたい場合: `query=stocks:>15` や `query=created:>YYYY-MM-DD stocks:>10` など（API の query 構文で絞り込み）。
  - シンプルに新着: `per_page=20` のみでも可。
- **レート制限**: 認証なし 60 req/h。Cron が1日1回程度なら問題なし。必要なら `Authorization: Bearer <token>` で 1000 req/h に増やせる。
- **レスポンス**: JSON。各要素に `title`, `url` があるので、`[Qiita] ${item.title} - ${item.url}` で統一形式にできる。

### 実装方針

1. まずは公式 API のみで実装（`fetchQiita()`）。
2. User-Agent を付与（`User-Agent: MyNewsBot/1.0`）するとブロックされにくい場合がある。
3. トレンド API は「トレンドに特化したい」場合の代替案として後から検討可能。

### コード例（イメージ）

```ts
async function fetchQiita(perPage = 10): Promise<string[]> {
  const res = await fetch(
    `https://qiita.com/api/v2/items?page=1&per_page=${perPage}`,
    { headers: { "User-Agent": "MyNewsBot/1.0" } }
  );
  const items: Array<{ title: string; url: string }> = await res.json();
  if (!Array.isArray(items)) return [];
  return items.map((item) => `[Qiita] ${item.title} - ${item.url}`);
}
```

---

## 3. 本番への組み込み

1. **依存**
   - Zenn: `fast-xml-parser` を追加。

2. **scheduled の変更**
   - `Promise.all` に `fetchZenn()` と `fetchQiita()` を追加。
   - 例: `const [redditNews, hnNews, zennNews, qiitaNews] = await Promise.all([...])`
   - `rawNewsList` に `...zennNews, ...qiitaNews` を結合。

3. **プロンプト**
   - 既存の「ソース」に Zenn / Qiita が含まれるだけなので、プロンプトのルール（1行1件・最大5件など）はそのままでよい。必要なら「日本語の記事はそのまま、英語は日本語訳」などと明示してもよい。

4. **エラー耐性**
   - 既存と同様、各 fetch を try/catch で囲み、失敗時は `[]` を返して他ソースの結果だけで続行。

5. **件数バランス**
   - 4ソースになるとリストが長くなるので、各ソース 5〜10 件に抑えると Gemini の入力も安定する。

---

## 4. まとめ

| 項目 | Zenn | Qiita |
|------|------|-------|
| 取得方法 | 公式 RSS `https://zenn.dev/feed` | 公式 API `GET /api/v2/items` |
| パース | fast-xml-parser で XML → item.title / item.link | JSON の title / url |
| 新規依存 | fast-xml-parser | なし |
| レート制限 | 特になし（RSS） | 60/h（未認証） |

この方針で `fetchZenn` と `fetchQiita` を追加し、既存の `fetchReddit` / `fetchHackerNews` と同様に `scheduled` 内の `Promise.all` と `rawNewsList` に組み込めば、Zenn と Qiita に対応できる。
