---
kind: api
schemaVersion: 0
domains:
  - etherscan.io
shortName: Etherscan V2
icon: 🔗
organization: etherscan
description: Ethereum chain data (balances, transactions, blocks, gas). Keyed via the `apikey` query param (A2 — the security-critical axis).
apiHost: https://api.etherscan.io/v2/api
auth:
  kind: static-key
  secretQueryRefs:
    apikey: api_key
  requires:
    - api_key
responseShape:
  format: json
  charset: utf-8
verified: "2026-12-01"
docs: https://docs.etherscan.io
operations:
  # ── Account ────────────────────────────────────────────────────────────
  - name: getBalance
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default). V2 requires this param.
      module:
        default: account
        description: ETH balance endpoint module (account).
      action:
        default: balance
        description: ETH balance action.
      address:
        required: true
        description: The wallet address (0x-prefixed) to query.
      tag:
        default: latest
        description: "Block tag — latest (default), earliest, or a hex block number up to the last 128 blocks."

  - name: getBalanceMulti
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: balancemulti
        description: Native balance for multiple addresses action.
      address:
        required: true
        description: "Comma-separated wallet addresses (0x-prefixed), up to 20 per call."
      tag:
        default: latest
        description: "Block tag — latest (default), earliest, or a hex block number."

  - name: getTransactions
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: txlist
        description: Normal (EOA) transaction list action.
      address:
        required: true
        description: The wallet address whose transactions to list (0x-prefixed).
      startblock:
        description: Starting block number (0 = genesis).
      endblock:
        description: Ending block number.
      sort:
        default: desc
        description: Sort by block — asc or desc (default).
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).

  - name: getTokenTransfers
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: tokentx
        description: ERC-20 token transfer list action.
      address:
        required: true
        description: The wallet address whose ERC-20 transfers to list (0x-prefixed).
      contractaddress:
        description: Filter to transfers of a single ERC-20 token contract.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: desc
        description: Sort by block — asc or desc (default).

  - name: getNftTransfers
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: tokennfttx
        description: ERC-721/NFT transfer list action.
      address:
        required: true
        description: The wallet address whose NFT transfers to list (0x-prefixed).
      contractaddress:
        description: Filter to transfers of a single NFT contract.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: desc
        description: Sort by block — asc or desc (default).

  - name: getErc1155Transfers
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: token1155tx
        description: ERC-1155 token transfer list action.
      address:
        required: true
        description: The wallet address whose ERC-1155 transfers to list (0x-prefixed).
      contractaddress:
        description: Filter to transfers of a single ERC-1155 contract.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: desc
        description: Sort by block — asc or desc (default).

  - name: getInternalTransactions
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: txlistinternal
        description: Internal transaction list action.
      address:
        required: true
        description: The wallet address (or contract address) whose internal txs to list (0x-prefixed).
      startblock:
        description: Starting block number.
      endblock:
        description: Ending block number.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: desc
        description: Sort by block — asc or desc (default).

  - name: getInternalTransactionsByBlock
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: txlistinternal
        description: Internal transaction list action (block-scoped).
      startblock:
        required: true
        description: Starting block number of the range.
      endblock:
        required: true
        description: Ending block number of the range.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: asc
        description: Sort order — asc (default) or desc.

  - name: getInternalTransactionsByHash
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: txlistinternal
        description: Internal transaction action (by tx hash).
      txhash:
        required: true
        description: The transaction hash (0x-prefixed) whose internal calls to list.

  - name: getMinedBlocks
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: getminedblocks
        description: Blocks validated by an address action.
      address:
        required: true
        description: The miner/validator address (0x-prefixed).
      blocktype:
        default: blocks
        description: "blocks for full blocks, optionally uncles for pre-Merge blocks."
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).

  - name: getBeaconWithdrawals
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: txsBeaconWithdrawal
        description: Beacon-chain withdrawal list action (camelCase action name).
      address:
        description: The recipient address (0x-prefixed) to filter withdrawals.
      startblock:
        description: Starting block number.
      endblock:
        description: Ending block number.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: asc
        description: Sort order — asc (default) or desc.

  - name: getWithdrawalTransactions
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 10
        description: L2 chain ID — 10 (Optimism) or 42161 (Arbitrum). This endpoint is L2-only.
      module:
        default: account
      action:
        default: getwithdrawaltxs
        description: Cross-chain L2→L1 withdrawal list action.
      address:
        required: true
        description: The address to check for cross-chain withdrawals.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: asc
        description: Sort order — asc (default) or desc.

  - name: getDepositTransactions
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 10
        description: L2 chain ID — 10 (Optimism) or 42161 (Arbitrum). This endpoint is L2-only.
      module:
        default: account
      action:
        default: getdeposittxs
        description: L1→L2 deposit transaction list action.
      address:
        required: true
        description: The address to check for deposits.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 10000).
      sort:
        default: asc
        description: Sort order — asc (default) or desc.

  # ── Blocks ────────────────────────────────────────────────────────────
  - name: getBlockReward
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: block
      action:
        default: getblockreward
        description: Block reward (+ uncles + txfees) action.
      blockno:
        required: true
        description: The block number to look up.

  - name: getBlockCountdown
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: block
      action:
        default: getblockcountdown
        description: Estimated time until a block is mined.
      blockno:
        required: true
        description: A not-yet-mined block number; returns remaining time in seconds.

  - name: getBlockNumberByTimestamp
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: block
      action:
        default: getblocknobytime
        description: Block number mined at a timestamp.
      timestamp:
        required: true
        description: UNIX timestamp (seconds) to resolve.
      closest:
        required: true
        description: "before or after — which neighbouring block to return."

  # ── Contracts ─────────────────────────────────────────────────────────
  - name: getAbi
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: contract
      action:
        default: getabi
        description: Contract ABI retrieval action.
      address:
        required: true
        description: The verified contract address (0x-prefixed).

  - name: getSourceCode
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: contract
      action:
        default: getsourcecode
        description: Verified contract source retrieval action.
      address:
        required: true
        description: The verified contract address (0x-prefixed).

  - name: getContractCreation
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: contract
      action:
        default: getcontractcreation
        description: Contract deployer + creation-tx action.
      contractaddresses:
        required: true
        description: "Comma-separated contract addresses (0x-prefixed)."

  # ── Gas Tracker ───────────────────────────────────────────────────────
  - name: getGasOracle
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: gastracker
      action:
        default: gasoracle
        description: Live gas price oracle action.

  - name: getGasEstimate
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: gastracker
      action:
        default: gasestimate
        description: Confirmation-time estimate for a gas price.
      gasprice:
        required: true
        description: Gas price in gwei; returns estimated confirmation time.

  # ── Geth/Parity Proxy ─────────────────────────────────────────────────
  - name: getBlockNumber
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_blockNumber
        description: Latest block number action (hex result).

  - name: getBlockByNumber
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getBlockByNumber
        description: Block info by number.
      tag:
        required: true
        description: "Block tag — latest, earliest, pending, or a hex block number."
      boolean:
        required: true
        description: "true to include full transaction objects, false for tx hashes only."

  - name: getBlockTransactionCountByNumber
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getBlockTransactionCountByNumber
        description: Transaction count of a block.
      tag:
        required: true
        description: "Block tag — latest, earliest, pending, or a hex block number."

  - name: getUncleByBlockNumberAndIndex
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getUncleByBlockNumberAndIndex
        description: Uncle block details.
      tag:
        required: true
        description: "Block tag — latest, earliest, pending, or a hex block number."
      index:
        required: true
        description: Uncle's index within the block (hex).

  - name: getTransactionByHash
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getTransactionByHash
        description: Transaction details by hash.
      txhash:
        required: true
        description: The transaction hash (0x-prefixed).

  - name: getTransactionByBlockNumberAndIndex
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getTransactionByBlockNumberAndIndex
        description: Transaction by block + position index.
      tag:
        required: true
        description: "Block tag — latest, earliest, pending, or a hex block number."
      index:
        required: true
        description: Transaction index within the block (hex).

  - name: getTransactionCount
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getTransactionCount
        description: Nonce/transaction count of an address.
      address:
        required: true
        description: The address (0x-prefixed) whose count to read.
      tag:
        required: true
        description: "Block tag — latest, earliest, pending, or a hex block number."

  - name: getTransactionReceipt
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getTransactionReceipt
        description: Transaction receipt by hash.
      txhash:
        required: true
        description: The transaction hash (0x-prefixed).

  - name: getCall
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_call
        description: Execute a view call without a transaction.
      to:
        required: true
        description: The contract address to interact with (0x-prefixed).
      data:
        description: "Hex-encoded method selector + args (e.g. 0x70a08231… for balanceOf)."
      tag:
        default: latest
        description: "Block tag — latest (default), earliest, pending, or a hex block number."

  - name: getCode
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getCode
        description: Bytecode stored at an address.
      address:
        required: true
        description: The address (0x-prefixed) whose code to read.
      tag:
        default: latest
        description: "Block tag — latest (default) or a hex block number."

  - name: getStorageAt
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_getStorageAt
        description: Value at a storage position.
      address:
        required: true
        description: The contract address (0x-prefixed).
      position:
        required: true
        description: Storage slot position (hex).
      tag:
        default: latest
        description: "Block tag — latest (default) or a hex block number."

  - name: getGasPrice
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: proxy
      action:
        default: eth_gasPrice
        description: Current gas price in wei.

  # ── Logs ──────────────────────────────────────────────────────────────
  - name: getLogs
    via: paginate
    path: /
    accept: json
    pagination:
      style: page
      itemsPath: result
      pageParam: page
      pageSizeParam: offset
      pageSize: 100
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: logs
      action:
        default: getLogs
        description: Event-log retrieval action (camelCase action name).
      address:
        required: true
        description: The contract address whose logs to fetch (0x-prefixed).
      fromBlock:
        required: true
        description: Starting block number.
      toBlock:
        required: true
        description: Ending block number.
      topic0:
        description: "Optional topic0 to filter (64-hex, 0x-prefixed), e.g. an event signature."
      topic1:
        description: Optional topic1 filter. Pair with topic1_1_opr for comparison ops.
      topic1_1_opr:
        description: "and or or — topic comparison operator."
      topic2:
        description: Optional topic2 filter.
      topic3:
        description: Optional topic3 filter.
      page:
        description: Page number (1-based).
      offset:
        description: Rows per page (max 1000).

  # ── Transactions ──────────────────────────────────────────────────────
  - name: getTxStatus
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: transaction
      action:
        default: getstatus
        description: Contract execution status action.
      txhash:
        required: true
        description: The transaction hash (0x-prefixed).

  - name: getTxReceiptStatus
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: transaction
      action:
        default: gettxreceiptstatus
        description: Transaction receipt status action.
      txhash:
        required: true
        description: The transaction hash (0x-prefixed).

  # ── Stats ─────────────────────────────────────────────────────────────
  - name: getEthSupply
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: ethsupply
        description: Circulating ETH supply action (excludes staking rewards + burned fees).

  - name: getEthSupply2
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: ethsupply2
        description: Total ETH supply action (incl. staking rewards, burned fees, beacon withdrawals).

  - name: getEthPrice
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: ethprice
        description: Latest ETH price + market-cap action.

  - name: getChainSize
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: chainsize
        description: Blockchain size in bytes action.
      startdate:
        required: true
        description: Start date (YYYY-MM-DD).
      enddate:
        required: true
        description: End date (YYYY-MM-DD).
      clienttype:
        default: geth
        description: "Client type — geth (default), parity."
      syncmode:
        default: default
        description: "Sync mode — default, archive."

  - name: getNodeCount
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: nodecount
        description: Discoverable node count action.

  - name: getNodeCountHistory
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: nodecounthistory
        description: Historical daily node count action.
      startdate:
        required: true
        description: Start date (YYYY-MM-DD).
      enddate:
        required: true
        description: End date (YYYY-MM-DD).

  - name: getTokenSupply
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: stats
      action:
        default: tokensupply
        description: ERC-20 total supply action.
      contractaddress:
        required: true
        description: The ERC-20 token contract address (0x-prefixed).

  - name: getTokenBalance
    via: restGet
    path: /
    accept: json
    params:
      chainid:
        default: 1
        description: Chain ID — 1 for Ethereum mainnet (default).
      module:
        default: account
      action:
        default: tokenbalance
        description: ERC-20 balance of an address action.
      contractaddress:
        required: true
        description: The ERC-20 token contract address (0x-prefixed).
      address:
        required: true
        description: The wallet address (0x-prefixed) holding the token.
      tag:
        default: latest
        description: "Block tag — latest (default) or a hex block number."

  # ── Usage ─────────────────────────────────────────────────────────────
  - name: getApiUsage
    via: restGet
    path: /
    accept: json
    params:
      module:
        default: getapilimit
        description: API-usage limit module (no chainid — this endpoint is chain-agnostic).
      action:
        default: getapilimit
        description: API-usage limit action.
---
# Etherscan V2 — Ethereum chain data

The Etherscan V2 API serves account, transaction, block, contract, and gas
data for Ethereum (and 60+ EVM chains, via `chainid`). **Keyed via the
`apikey` query param** — this is the security-critical axis (A2): the key
is injected from the secrets store **below** the guide's params map and
redacted from every surfaced URL (`?apikey=***`), so you never see or pass
it. Provision it once via `/api secrets etherscan.io`, then call operations
as usual.

V2 requires a `chainid` query param on every on-chain call (the guide
defaults it to `1` for Ethereum mainnet — override for L2s). The key is a
**required** secret: if it isn't provisioned, `/api secrets etherscan.io`
will prompt you. Free tier: 3 calls/s, 100k calls/day. The
PRO-gated endpoints (holder lists, balance/supply history, funded-by,
address metadata) are intentionally omitted — see
`docs/design/api-auth-recipe-candidates.md` for why.

Every response wraps data under a `result` key; failures return
`status: "0"` with an error `message`/`result` string. Amounts are returned
in the token's smallest unit (wei for native ETH, raw for ERC-20) unless
documented otherwise.

## Operations

### Account

- **`getBalance`** — native ETH balance of `address` at `tag`.
- **`getBalanceMulti`** — native balances of up to 20 comma-separated
  `address`es in one call (returns `{account, balance}` rows).
- **`getTransactions`** — normal (EOA) transactions of `address`,
  paginated `page`/`offset` (100/page). Each item has `hash`, `from`, `to`,
  `value`, `timeStamp`, `blockNumber`.
- **`getTokenTransfers`** — ERC-20 transfers involving `address`; filter by
  `contractaddress`.
- **`getNftTransfers`** — ERC-721/NFT transfers involving `address`.
- **`getErc1155Transfers`** — ERC-1155 transfers involving `address`.
- **`getInternalTransactions`** — internal (contract-to-contract / value)
  txs of `address`.
- **`getInternalTransactionsByBlock`** — all internal txs within a
  `startblock`→`endblock` range (no address).
- **`getInternalTransactionsByHash`** — internal calls executed inside a
  specific `txhash`.
- **`getMinedBlocks`** — blocks validated (mined) by `address`.
- **`getBeaconWithdrawals`** — beacon-chain (staked-ETH) withdrawals to
  `address`.
- **`getWithdrawalTransactions`** / **`getDepositTransactions`** — L2
  cross-chain withdrawal/deposit txs (Optimism/Arbitrum only).

### Blocks

- **`getBlockReward`** — reward (+ uncle rewards + txfees) for `blockno`.
- **`getBlockCountdown`** — estimated seconds until a not-yet-mined
  `blockno`.
- **`getBlockNumberByTimestamp`** — the block mined at a UNIX `timestamp`
  (choose `closest: before|after`).

### Contracts

- **`getAbi`** — the ABI of a verified contract at `address`.
- **`getSourceCode`** — verified source, ABI, compiler settings, contract
  name of `address`.
- **`getContractCreation`** — deployer address + creation tx hash for the
  given `contractaddresses`.

### Gas Tracker

- **`getGasOracle`** — live `SafeGasPrice` / `ProposeGasPrice` /
  `FastGasPrice` / `suggestBaseFee` (gwei).
- **`getGasEstimate`** — estimated confirmation time for a given
  `gasprice` (gwei).

### Geth/Parity Proxy

Raw EVM RPC passthroughs over HTTP GET. Hex values; many return JSON-RPC
shaped objects.

- **`getBlockNumber`** — latest block number (hex).
- **`getBlockByNumber`** — full block by `tag` (`boolean` toggles full txs
  vs hashes).
- **`getBlockTransactionCountByNumber`** — tx count of a block.
- **`getUncleByBlockNumberAndIndex`** — an uncle block by `tag` + `index`.
- **`getTransactionByHash`** — raw transaction by `txhash`.
- **`getTransactionByBlockNumberAndIndex`** — tx by `tag` + `index`.
- **`getTransactionCount`** — nonce of `address` at `tag`.
- **`getTransactionReceipt`** — receipt (logs, status, gasUsed) by `txhash`.
- **`getCall`** — execute a view call via `to` + `data` (no gas spent).
- **`getCode`** — deployed bytecode at `address`.
- **`getStorageAt`** — value at a `position` slot of `address`.
- **`getGasPrice`** — current gas price (wei, hex).

### Logs

- **`getLogs`** — raw event logs for `address` within `fromBlock`→`toBlock`,
  optionally filtered by `topic0`…`topic3` (for ERC-20 Transfer events,
  `topic0` is the standard `Transfer(address,address,uint256)` signature).
  Paginated `page`/`offset`.

### Transactions

- **`getTxStatus`** — contract execution status: `isError` + `errDescription`.
- **`getTxReceiptStatus`** — `status` for a tx hash (1 = success, 0 = failed).

### Stats

- **`getEthSupply`** / **`getEthSupply2`** — circulating vs total ETH supply.
- **`getEthPrice`** — current ETH price + market data.
- **`getChainSize`** — blockchain size in bytes over a `startdate`/`enddate`
  range (optionally per `clienttype`/`syncmode`).
- **`getNodeCount`** / **`getNodeCountHistory`** — current / historical
  node counts.
- **`getTokenSupply`** — ERC-20 total supply for a token contract.
- **`getTokenBalance`** — an address's ERC-20 balance for a token contract.

### Usage

- **`getApiUsage`** — your credits used / available / limit for the current
  interval. The only chain-agnostic op here (no `chainid`).

## Pagination

`getTransactions`, `getTokenTransfers`, `getNftTransfers`,
`getErc1155Transfers`, `getInternalTransactions`,
`getInternalTransactionsByBlock`, `getMinedBlocks`,
`getBeaconWithdrawals`, `getWithdrawalTransactions`, `getDepositTransactions`,
and `getLogs` use `page`/`offset` (1-based). Pass `gatherAll: true` to
`api-fetch` to walk pages up to the guide's ceiling.

## Notes

- The `apikey` and `chainid` params are handled by the store pipeline
  (`apikey` injected + redacted, so it never appears in surfaced URLs or the
  returned params map; `chainid` defaulted per op). Never add `apikey` to an
  op's `params` map — a collision is a parse error. When overriding
  `chainid` for an L2, pass it as a normal param (it is not a secret).
- V1 (`api.etherscan.io/api`) was deprecated in Aug 2025; this guide targets
  the V2 base path (`/v2/api`).
