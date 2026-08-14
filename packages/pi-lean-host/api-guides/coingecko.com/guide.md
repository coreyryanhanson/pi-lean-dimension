---
kind: api
domains:
  - coingecko.com
shortName: CoinGecko
icon: 🪙
organization: coingecko
description: Cryptocurrency market data (prices, markets, coin metadata). Keyed via a free demo API key.
apiHost: https://api.coingecko.com/api/v3
auth:
  kind: static-key
  secretRefs:
    x-cg-demo-api-key: api_key
  requires:
    - api_key
responseShape:
  format: json
  charset: utf-8
verified: "2026-12-01"
docs: https://docs.coingecko.com/reference/coins-markets
operations:
  - name: listMarkets
    via: paginate
    path: /coins/markets
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 100
    params:
      vs_currency:
        required: true
        default: usd
        description: The target currency for market prices (e.g. usd, eur, btc). CoinGecko requires it.
      order:
        default: market_cap_desc
        description: Sort order — market_cap_desc (default), market_cap_asc, volume_desc, gecko_desc, id_asc.
      price_change_percentage:
        description: Comma-separated time ranges for a % price-change field, e.g. "1h,24h,7d".

  - name: getCoin
    via: restGet
    path: /coins/{id}
    accept: json
    params:
      id:
        description: The coin's market id (e.g. bitcoin, ethereum, solana). Passed as a path token.
      localization:
        description: "false to drop localized names and slim the payload (id/name/symbol only)."
      tickers:
        default: false
        description: Include a tickers array from exchanges (heavy — default false keeps the response lean).
      market_data:
        default: true
        description: Include the market_data block (prices, supply, market cap).
      community_data:
        default: false
      developer_data:
        default: false
---
# CoinGecko — cryptocurrency market data

CoinGecko's public API returns live prices, market rankings, and coin
metadata. All endpoints here require a **demo API key** (`x-cg-demo-api-key`),
provisioned via `/api secrets coingecko.com` (the store resolves the
`api_key` secret and injects the header for you — you never see or pass the
key value).

The demo plan is free, needs no billing card, and allows ~100 calls/min with
no credit balance. If the response returns `401`/`403` or a `"status":
{"error_code": 401}` body, the key is missing or expired — re-provision via
`/api secrets coingecko.com`.

## Operations

### `listMarkets` — Ranked market list

Returns a paginated array of coin market rows ranked by market cap,
with price, 24h volume, and market-cap figures in the requested
`vs_currency`. Uses CoinGecko's `page`/`per_page` pagination (default
100 rows/page). Pass `gatherAll: true` to `api-fetch` to walk pages up
to the guide's ceiling.

### `getCoin` — Single coin detail

Returns a coin's full record by its market `id` (e.g. `bitcoin`).
Defaults keep the payload lean: `market_data: true`, `community_data` /
`developer_data` / `tickers` off. Set `localization: false` to drop
translated names and shrink the response further.

## Pagination

`listMarkets` uses `page`/`per_page` (1-based). The demo plan's per-page
cap is 250; the guide defaults to 100.

## Terms

Free usage is governed by CoinGecko's API terms. For keyless browsing the
reference CoinGecko guide (community/other sources) may apply; the demo key
raises rate limits substantially.
