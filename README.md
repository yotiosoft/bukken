# bukken-mcp-server

`SUUMO` と `LIFULL HOME'S` の物件詳細ページをスクレイピングして、物件情報を返す MCP サーバです。

## できること

- 物件詳細 URL を渡して取得
- `site + id` を渡して取得
  - `suumo`: `https://suumo.jp/chintai/jnc_<id>/`
  - `homes`: `https://www.homes.co.jp/chintai/b-<id>/`

返却項目:

- 物件名
- 住所
- 敷金/礼金
- 保証金
- 敷引・償却
- アクセス
- 間取り
- 専有面積
- 向き
- 建物種別
- 築年数
- 階建
- 損保
- 入居時期
- 条件
- 契約期間
- 仲介手数料
- 保証会社
- ほか初期費用
- 築年月
- 取引態様
- 備考

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
{ "site": "homes", "id": "1169340415053" }
```

## 注意

- スクレイピング対象サイトの HTML 構造変更により、取得項目が欠けることがあります
- 取得できた項目だけを返し、見つからない項目は `null` を返します
- 利用時は対象サイトの利用規約、robots、アクセス頻度に配慮してください
