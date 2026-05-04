# bukken-mcp-server

`SUUMO` と `LIFULL HOME'S` の物件詳細ページをスクレイピングして、物件情報を返す MCP サーバです。

## できること

- 物件詳細 URL を渡して取得
  - SUUMO 賃貸ページ
  - SUUMO 中古マンションページ
  - LIFULL HOME'S 賃貸ページ
- `site + id` を渡して取得
  - `suumo`: `https://suumo.jp/chintai/jnc_<id>/`
  - `homes`: `https://www.homes.co.jp/chintai/b-<id>/`

返却項目:

- 物件名
- 価格
- 住所
- 敷金
- 礼金
- 保証金
- 敷引・償却
- アクセス
- 間取り
- 専有面積
- その他面積
- バルコニー面積
- 向き
- 建物種別
- 築年数
- 所在階
- 階建
- 構造・階建て
- 損保
- 入居時期
- 引渡可能時期
- 条件
- 契約期間
- 仲介手数料
- 保証会社
- ほか初期費用
- 管理費
- 修繕積立金
- 修繕積立基金
- 諸費用
- 販売スケジュール
- 販売戸数
- 総戸数
- 敷地面積
- 敷地の権利形態
- 用途地域
- 駐車場
- 築年月
- 施工
- 取引態様
- 備考
- 担当者
- 会社概要
- 問い合わせ先
- 情報提供日
- 次回更新予定日
- 取引条件有効期限
- 部屋の特徴・設備

## 起動

```powershell
npm install
npm run build
$env:HOST = "127.0.0.1"
$env:PORT = "5722"
$env:MCP_PATH = "/mcp-bukken-q7v5f2"
npm start
```

開発用:

```powershell
npm run dev
```

## MCP ツール

ツール名: `scrape_listing`

入力例:

```json
{ "url": "https://suumo.jp/chintai/jnc_000099999999/" }
```

```json
{ "url": "https://suumo.jp/ms/chuko/tokyo/sc_shinjuku/nc_20394654/" }
```

```json
{ "site": "homes", "id": "1169340415053" }
```

## 注意

- スクレイピング対象サイトの HTML 構造変更により、取得項目が欠けることがあります
- 取得できた項目だけを返し、見つからない項目は `null` を返します
- 利用時は対象サイトの利用規約、robots、アクセス頻度に配慮してください
