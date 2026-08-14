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
      page:
        default: 1
        description: Page through results (1-based — CoinGecko treats page 0 as page 1, which would duplicate the first page on gatherAll).

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

  - name: getCoinByContract
    via: restGet
    path: /coins/{id}/contract/{contract_address}
    accept: json
    params:
      id:
        description: Asset platform ID (e.g. ethereum). Passed as a path token.
      contract_address:
        description: The token's contract address on that platform. Passed as a path token.

  - name: getTickers
    via: restGet
    path: /coins/{id}/tickers
    accept: json
    params:
      id:
        description: The coin's market id (e.g. bitcoin). Passed as a path token.
      page:
        default: 1
        description: Page through results (100 tickers per page).
      exchange_ids:
        description: Comma-separated exchange IDs to filter tickers (from /exchanges/list).
      include_exchange_logo:
        default: false
        description: Include exchange logos in the response.
      order:
        default: trust_score_desc
        description: Sort order — trust_score_desc (default), trust_score_asc, volume_desc, volume_asc.
      depth:
        default: false
        description: Include 2% orderbook depth (cost_to_move_up/down usd).
      dex_pair_format:
        default: contract_address
        description: "DEX pair base/target display — contract_address (default) or symbol."

  - name: getHistory
    via: restGet
    path: /coins/{id}/history
    accept: json
    params:
      id:
        description: The coin's market id (e.g. bitcoin). Passed as a path token.
      date:
        required: true
        description: Snapshot date in dd-mm-yyyy format (e.g. 30-12-2025). Demo tier covers the past 365 days.
      localization:
        default: true
        description: Include localized names in the response.

  - name: getMarketChart
    via: restGet
    path: /coins/{id}/market_chart
    accept: json
    params:
      id:
        description: The coin's market id (e.g. bitcoin). Passed as a path token.
      vs_currency:
        required: true
        default: usd
        description: Target currency for the chart (from /simple/supported_vs_currencies).
      days:
        required: true
        default: "30"
        description: Number of days of history (integer or max). Demo tier caps at 365 days.
      interval:
        description: "Data interval — daily or hourly. Leave empty for auto-granularity."
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getMarketChartRange
    via: restGet
    path: /coins/{id}/market_chart/range
    accept: json
    params:
      id:
        description: The coin's market id (e.g. bitcoin). Passed as a path token.
      vs_currency:
        required: true
        default: usd
        description: Target currency for the chart.
      from:
        required: true
        description: Start of the range — ISO date (YYYY-MM-DD) or UNIX timestamp.
      to:
        required: true
        description: End of the range — ISO date (YYYY-MM-DD) or UNIX timestamp.
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getOhlc
    via: restGet
    path: /coins/{id}/ohlc
    accept: json
    params:
      id:
        description: The coin's market id (e.g. bitcoin). Passed as a path token.
      vs_currency:
        required: true
        default: usd
        description: Target currency for the OHLC prices.
      days:
        required: true
        default: "30"
        description: Number of days of OHLC history (integer or max).
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getContractMarketChart
    via: restGet
    path: /coins/{id}/contract/{contract_address}/market_chart
    accept: json
    params:
      id:
        description: Asset platform ID (e.g. ethereum). Passed as a path token.
      contract_address:
        description: The token's contract address on that platform. Passed as a path token.
      vs_currency:
        required: true
        default: usd
        description: Target currency for the chart.
      days:
        required: true
        default: "30"
        description: Number of days of history (integer or max).
      interval:
        description: "Data interval — daily or hourly. Leave empty for auto-granularity."
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getContractMarketChartRange
    via: restGet
    path: /coins/{id}/contract/{contract_address}/market_chart/range
    accept: json
    params:
      id:
        description: Asset platform ID (e.g. ethereum). Passed as a path token.
      contract_address:
        description: The token's contract address on that platform. Passed as a path token.
      vs_currency:
        required: true
        default: usd
        description: Target currency for the chart.
      from:
        required: true
        description: Start of the range — ISO date (YYYY-MM-DD) or UNIX timestamp.
      to:
        required: true
        description: End of the range — ISO date (YYYY-MM-DD) or UNIX timestamp.
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getSimplePrice
    via: restGet
    path: /simple/price
    accept: json
    params:
      ids:
        default: bitcoin
        description: Coin IDs, comma-separated (or names/symbols via the other lookups).
      names:
        description: Coin names, comma-separated (alternative to ids).
      symbols:
        description: Coin symbols, comma-separated (alternative to ids).
      vs_currencies:
        required: true
        default: usd
        description: Target currencies, comma-separated (from /simple/supported_vs_currencies).
      include_market_cap:
        default: false
        description: Include market capitalization in the result.
      include_24hr_vol:
        default: false
        description: Include 24-hour trading volume.
      include_24hr_change:
        default: false
        description: Include 24-hour change percentage.
      include_last_updated_at:
        default: false
        description: Include last-updated time as a UNIX timestamp.
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getTokenPrice
    via: restGet
    path: /simple/token_price/{id}
    accept: json
    params:
      id:
        description: Asset platform ID (e.g. ethereum). Passed as a path token.
      contract_addresses:
        required: true
        description: Token contract addresses, comma-separated (max 515 per request).
      vs_currencies:
        required: true
        default: usd
        description: Target currencies, comma-separated.
      include_market_cap:
        default: false
      include_24hr_vol:
        default: false
      include_24hr_change:
        default: false
      include_last_updated_at:
        default: false
      precision:
        description: Decimal places for price values (full, or 0-5).

  - name: getSupportedCurrencies
    via: restGet
    path: /simple/supported_vs_currencies
    accept: json
    params: {}

  - name: getExchangeRates
    via: restGet
    path: /exchange_rates
    accept: json
    params: {}

  - name: search
    via: restGet
    path: /search
    accept: json
    params:
      query:
        required: true
        description: Search query string — matches coins, categories, exchanges and NFTs by name or symbol.

  - name: getTrending
    via: restGet
    path: /search/trending
    accept: json
    params: {}

  - name: getGlobal
    via: restGet
    path: /global
    accept: json
    params: {}

  - name: getGlobalDefi
    via: restGet
    path: /global/decentralized_finance_defi
    accept: json
    params: {}

  - name: getCategoriesList
    via: restGet
    path: /coins/categories/list
    accept: json
    params: {}

  - name: getCategories
    via: restGet
    path: /coins/categories
    accept: json
    params:
      order:
        default: market_cap_desc
        description: Sort order — market_cap_desc (default), market_cap_asc, name_desc, name_asc, market_cap_change_24h_desc, market_cap_change_24h_asc.

  - name: getCoinList
    via: restGet
    path: /coins/list
    accept: json
    params:
      include_platform:
        default: false
        description: Include each coin's asset platform and token contract addresses.
      status:
        default: active
        description: Filter by coin status — active (default) or inactive.

  - name: getAssetPlatforms
    via: restGet
    path: /asset_platforms
    accept: json
    params:
      filter:
        description: Filter to NFT-supported asset platforms (nft).

  - name: getExchangesList
    via: restGet
    path: /exchanges/list
    accept: json
    params: {}

  - name: getExchanges
    via: paginate
    path: /exchanges
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 100
    params:
      page:
        default: 1
        description: Page through results (1-based — CoinGecko treats page 0 as page 1, which would duplicate the first page on gatherAll).

  - name: getExchange
    via: restGet
    path: /exchanges/{id}
    accept: json
    params:
      id:
        description: The exchange's id (e.g. binance) — from /exchanges/list. Passed as a path token.

  - name: getExchangeTickers
    via: restGet
    path: /exchanges/{id}/tickers
    accept: json
    params:
      id:
        description: The exchange's id (e.g. binance). Passed as a path token.
      coin_ids:
        description: Filter tickers by coin IDs, comma-separated (from /coins/list).
      page:
        default: 1
        description: Page through results (100 tickers per page).
      depth:
        default: false
        description: Include 2% orderbook depth (cost_to_move_up_usd/down_usd).
      order:
        default: trust_score_desc
        description: Sort order — trust_score_desc (default), trust_score_asc, volume_desc, volume_asc, base_target.

  - name: getExchangeVolumeChart
    via: restGet
    path: /exchanges/{id}/volume_chart
    accept: json
    params:
      id:
        description: The exchange's id (e.g. binance). Passed as a path token.
      days:
        required: true
        default: "1"
        description: Number of days of volume history (7/14 days = hourly, 30+ = daily).

  - name: getDerivativesExchangesList
    via: restGet
    path: /derivatives/exchanges/list
    accept: json
    params: {}

  - name: getDerivatives
    via: restGet
    path: /derivatives
    accept: json
    params: {}

  - name: getDerivativesExchanges
    via: paginate
    path: /derivatives/exchanges
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 100
    params:
      order:
        default: open_interest_btc_desc
        description: Sort order — open_interest_btc_desc (default), open_interest_btc_asc, name_asc, name_desc, trade_volume_24h_btc_desc, trade_volume_24h_btc_asc.
      page:
        default: 1
        description: Page through results (1-based).

  - name: getDerivativesExchange
    via: restGet
    path: /derivatives/exchanges/{id}
    accept: json
    params:
      id:
        description: The derivative exchange's id (e.g. binance_futures) — from getDerivativesExchangesList. Passed as a path token.
      include_tickers:
        description: "Include tickers — all (all tickers) or unexpired (unexpired only). Omit to skip tickers."

  - name: getNftsList
    via: paginate
    path: /nfts/list
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 100
    params:
      order:
        default: h24_volume_usd_desc
        description: Sort order — h24_volume_usd_desc (default), h24_volume_usd_asc, h24_volume_native_desc, h24_volume_native_asc, floor_price_native_desc, floor_price_native_asc, market_cap_native_desc, market_cap_native_asc, market_cap_usd_desc, market_cap_usd_asc.
      page:
        default: 1
        description: Page through results (1-based).

  - name: getNft
    via: restGet
    path: /nfts/{id}
    accept: json
    params:
      id:
        description: The NFT collection's id (e.g. pudgy-penguins) — from getNftsList. Passed as a path token.

  - name: getNftByContract
    via: restGet
    path: /nfts/{asset_platform_id}/contract/{contract_address}
    accept: json
    params:
      asset_platform_id:
        description: The asset platform id (e.g. ethereum) — from getAssetPlatforms. Passed as a path token.
      contract_address:
        description: The NFT collection's contract address on that platform. Passed as a path token.

  - name: getEntitiesList
    via: restGet
    path: /entities/list
    accept: json
    params:
      entity_type:
        description: Filter by entity type — company or government.
      per_page:
        default: 100
        description: Results per page.
      page:
        default: 1
        description: Page through results.

  - name: getTreasuryByCoin
    via: paginate
    path: /{entity}/public_treasury/{coin_id}
    accept: json
    pagination:
      style: page
      itemsPath: $
      pageParam: page
      pageSizeParam: per_page
      pageSize: 250
    params:
      entity:
        description: "Public entity type — companies (default) or governments. Passed as a path token."
      coin_id:
        description: "Coin ID (e.g. bitcoin, ethereum). Passed as a path token."
      page:
        default: 1
        description: Page through results (1-based).

  - name: getTreasuryByEntity
    via: restGet
    path: /public_treasury/{entity_id}
    accept: json
    params:
      entity_id:
        description: "Entity ID (e.g. strategy) — from getEntitiesList. Passed as a path token."
      holding_amount_change:
        description: "Include holding amount change — comma-separated timeframes: 7d, 14d, 30d, 90d, 1y, ytd."
      holding_change_percentage:
        description: "Include holding change % — comma-separated timeframes: 7d, 14d, 30d, 90d, 1y, ytd."

  - name: getTreasuryHoldingChart
    via: restGet
    path: /public_treasury/{entity_id}/{coin_id}/holding_chart
    accept: json
    params:
      entity_id:
        description: "Entity ID (e.g. strategy) — from getEntitiesList. Passed as a path token."
      coin_id:
        description: "Coin ID (e.g. bitcoin, ethereum). Passed as a path token."
      days:
        required: true
        default: "365"
        description: "Days of history — 7, 14, 30, 90, 180 or 365. Demo tier caps at 365."
      include_empty_intervals:
        default: false
        description: "Include intervals with no transactions, filled with the most recent data."

  - name: getTreasuryTransactions
    via: restGet
    path: /public_treasury/{entity_id}/transaction_history
    accept: json
    params:
      entity_id:
        description: "Entity ID (e.g. strategy) — from getEntitiesList. Passed as a path token."
      coin_ids:
        description: "Filter by coin IDs, comma-separated (from getCoinList)."
      per_page:
        default: 100
        description: Results per page.
      order:
        default: date_desc
        description: Sort order — date_desc (default), date_asc, holding_net_change_desc, holding_net_change_asc, transaction_value_usd_desc, transaction_value_usd_asc, average_cost_desc, average_cost_asc.
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

### `getCoinByContract` — Coin data by token contract address

Returns the same full coin record as `getCoin`, but looked up by asset
platform + token contract address instead of coin ID. `id` is the
platform (e.g. `ethereum`), `contract_address` the token's contract —
useful for ERC-20-style tokens that lack a clean market id.

### `getTickers` — Exchange tickers for a coin

Returns the coin's tickers across CEX and DEX exchanges (100 per
page, single page per call — pass `page` to advance). Filter with
`exchange_ids`, sort with `order`, and set `dex_pair_format: symbol`
to show DEX pairs as symbols instead of contract addresses.

### `getHistory` — Historical snapshot at a date

Returns a price/market-cap/volume snapshot at `00:00 UTC` for a given
`date` (`dd-mm-yyyy`). Demo tier is limited to the past 365 days.

### `getMarketChart` — Historical price/market-cap/volume chart

Returns time-series arrays (`prices`, `market_caps`, `total_volumes`) as
`[timestamp, value]` pairs for the last `days`. `days` accepts an integer or
`max`; granularity is auto (5-min within 1 day, hourly 2–90, daily beyond)
unless overridden with `interval`.

### `getMarketChartRange` — Chart data within a time range

Like `getMarketChart` but bounded by explicit `from`/`to` instead of a
`days` window. Both accept ISO dates (`YYYY-MM-DD`) or UNIX timestamps;
returns the same `prices`/`market_caps`/`total_volumes` shape.

### `getOhlc` — OHLC (candlestick) chart

Returns candlestick rows `[timestamp, open, high, low, close]` for the last
`days`. Candle granularity is auto (30-min within 1–2 days, 4-hour 3–30,
4-day beyond).

### `getContractMarketChart` — Token chart by contract address

Same series as `getMarketChart` but for an ERC-20-style token via `id`
(platform) + `contract_address` path tokens. WBTC on ethereum
(`0x2260fac5e5542a773aa44fbcfedf7c193bc2c599`) is a reliable test vector.

### `getContractMarketChartRange` — Token chart within a time range

Same range-bounded series as `getMarketChartRange`, addressed by
platform + contract address.

### `getSimplePrice` — Live prices by ID/name/symbol

Returns current prices for one or more coins against one or more target `vs_currencies`. Look up by comma-separated `ids` (default), or switch to `names`/`symbols`. Toggle the `include_*` flags to also get market cap, 24h volume/change, or the last-updated timestamp; set `precision` to control decimals. Comma-separated `vs_currencies` supports several targets in one call.

### `getTokenPrice` — Token price by contract address

Returns prices for ERC-20-style tokens on an asset platform (`id`, e.g. `ethereum`) by their `contract_addresses`. `id` is a path token; `contract_addresses` and `vs_currencies` are required query params. Same `include_*` flags as `getSimplePrice`. Platform IDs come from `/asset_platforms` and coin contract addresses from `/coins/{id}/contract/{address}` (both later batches).

### `getSupportedCurrencies` — All `vs_currencies` codes

The canonical list of currency codes accepted as `vs_currencies` elsewhere (usd, eur, btc, …). No params — returns a flat array.

### `getExchangeRates` — BTC-to-currency rates

Returns BTC-denominated exchange rates for many fiat and crypto currencies, keyed by currency code under a `rates` object. No params.

### `search` — Search coins, categories, exchanges, NFTs

Returns ranked results for a free-form `query`, matching coins, categories,
exchanges and NFTs by name or symbol. Results are sorted by market cap
descending; matches are grouped under `coins`/`categories`/`exchanges`/
`nfts` arrays. Good for resolving a coin ID from a fuzzy name.

### `getTrending` — Trending search list

Returns the top-trending coins, NFTs and categories over the last 24 hours.
No params — a quick "what's hot" pull.

### `getGlobal` — Global crypto market data

Returns aggregate data across all cryptocurrencies: active coin count, total
market cap and volume (with 24h change), and BTC dominance. No params.

### `getGlobalDefi` — Global DeFi market data

Returns aggregate DeFi data for the top-100 DeFi assets: total market cap,
24h trading volume, and their change percentages. No params.

### `getCategoriesList` — Coin category ID map

Returns the flat list of coin categories, each with `category_id` and
`name`. Use it to resolve a category ID for `listMarkets`' `category`
filter or to browse the `getCategories` market-data variant below. No
params.

### `getCategories` — Categories with market data

Returns all coin categories with market data — `market_cap`,
`market_cap_change_24h`, `volume_24h`, `top_3_coins`, and a description
— sorted by `order` (default `market_cap_desc`). Good for a sector-level
overview (e.g. DeFi, Layer 1, Memes).

### `getCoinList` — Coin ID/symbol/name map

Returns the full list of coins (`id`, `symbol`, `name`; plus `platforms`
contract addresses when `include_platform: true`). The canonical way to
resolve a coin `id` for `getCoin`/`getMarketChart`. No pagination — the
whole list comes back in one call. Access to inactive coins is restricted
on the demo tier (the `status: inactive` filter returns little).

### `getAssetPlatforms` — Asset platform (chain) map

Returns the supported blockchain networks (ethereum, solana,
binance-smart-chain, ...) with chain IDs, names, and native coin IDs. Use
it to resolve the platform `id` path token for the contract-address
endpoints (`getCoinByContract`, `getTokenPrice`). Pass `filter: nft` for
NFT-supported platforms only.

### `getExchangesList` — Exchange ID map

Returns all supported exchanges as `id`/`name` pairs. Resolve an exchange
`id` to pass to `getExchange`/`getExchangeTickers`/
`getExchangeVolumeChart`. No params.

### `getExchanges` — Exchanges with market data

Returns exchanges with active trading data — name, country, trust score,
hype score, 24h volume, and trade URLs — paginated by `per_page`/`page`.
Pass `gatherAll: true` to walk all pages.

### `getExchange` — Exchange detail

Returns a single exchange's full record by its `id` (e.g. `binance`):
metadata and trust-score blocks plus its top 100 tickers. `id` comes from
`getExchangesList`.

### `getExchangeTickers` — Exchange tickers

Returns an exchange's tickers (100 per page, single page — pass `page` to
advance). Filter to specific coins with `coin_ids` (from `/coins/list`),
sort with `order` (set `base_target` for stable pagination), and toggle
`depth` to include 2% orderbook depth.

### `getExchangeVolumeChart` — Historical volume chart

Returns `[timestamp, volume_btc]` pairs for the last `days` of trading
volume (in BTC). Granularity is hourly at 7/14 days, daily from 30 days up.

### `getDerivatives` — All derivative tickers

Returns every derivatives ticker across exchanges — market, symbol, index,
price, basis, spread, funding rate, open interest and 24h volume. No
params.

### `getDerivativesExchangesList` — Derivative exchange ID map

Returns all supported derivatives exchanges as `id`/`name` pairs. Resolve
an `id` to pass to `getDerivativesExchange`. No params.

### `getDerivativesExchanges` — Derivatives exchanges with data

Returns derivatives exchanges with data — open interest, 24h trade volume,
perpetual/futures pair counts — paginated by `per_page`/`page`. Sort with
`order` (default `open_interest_btc_desc`).

### `getDerivativesExchange` — Derivative exchange detail

Returns a single derivatives exchange's record by `id` (e.g.
`binance_futures`). Set `include_tickers` to `all` (or `unexpired`) to also
include its tickers.

### `getNftsList` — NFT collection ID map

Returns all supported NFT collections (`id`, `contract_address`, `name`,
`asset_platform_id`, `symbol`), paginated 100 per page. Resolve an `id` for
`getNft` or a platform/address for `getNftByContract`. Sort with `order`.

### `getNft` — NFT collection data by ID

Returns a single NFT collection's data — floor price, 24h volume, market
cap — by its collection `id` (e.g. `pudgy-penguins`).

### `getNftByContract` — NFT collection data by contract address

Returns the same collection data as `getNft`, addressed by `asset_platform_id`
(e.g. `ethereum`) + `contract_address` instead of a collection ID.

### `getEntitiesList` — Treasury entity ID map

Returns public companies and governments that report crypto holdings (`id`,
`name`, `symbol`, `country`). Filter with `entity_type` (`company` /
`government`). Resolve the `entity_id` values used by the other treasury
endpoints.

### `getTreasuryByCoin` — Treasury holdings by coin ID

Returns the companies/governments holding a given `coin_id` (e.g.
`bitcoin`), sorted by total holdings and paginated by `per_page`/`page`.
`entity` selects `companies` (default) or `governments`.

### `getTreasuryByEntity` — Treasury holdings by entity ID

Returns a single entity's full treasury record — total value, unrealized
PnL, per-share asset value, and its `holdings` array — by `entity_id`.
Optionally include `holding_amount_change` / `holding_change_percentage`
for 7d/14d/30d/90d/1y/ytd timeframes.

### `getTreasuryHoldingChart` — Historical treasury holdings chart

Returns `[timestamp, amount]` and `[timestamp, value_usd]` series for an
entity's holding of a coin over the last `days` (7–365 on the demo tier).
Set `include_empty_intervals: true` to return every interval.

### `getTreasuryTransactions` — Treasury transaction history

Returns an entity's crypto transactions (buys/sells) under `transactions`,
sorted by `order`. Filter with `coin_ids`. Note: paging past page 1 is
Analyst-plan-only on the demo key.

## Pagination

`listMarkets`, `getExchanges`, `getDerivativesExchanges`, `getNftsList` and
`getTreasuryByCoin` use `page`/`per_page` (1-based). The demo plan's
per-page cap is 250; the guide defaults to 100.

## Terms

Free usage is governed by CoinGecko's API terms. For keyless browsing the
reference CoinGecko guide (community/other sources) may apply; the demo key
raises rate limits substantially.
