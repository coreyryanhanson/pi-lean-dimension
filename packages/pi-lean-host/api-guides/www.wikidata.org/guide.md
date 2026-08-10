---
kind: api
domains:
  - www.wikidata.org
  - wikidata.org
shortName: Wikidata
icon: 🔣
apiHost: https://www.wikidata.org
auth:
  kind: none
responseShape:
  format: json
  charset: utf-8
verified: "2026-07-18"
docs: https://www.wikidata.org/wiki/Wikidata:Data_access
operations:
  - name: getEntity
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        description: Wikidata action.
        default: wbgetentities
      ids:
        description: >
          Entity ID(s) to fetch, pipe-separated for multiple
          (e.g. `Q42`). Required.
        required: true
      props:
        description: Which property groups to return.
        default: labels
      languages:
        description: >
          Pipe-separated language codes for labels/descriptions
          (e.g. `zh|ar|ru|en`). Pass multiple to stress non-Latin-script
          decoding in one response.
        default: zh|ar|ru|en
      format:
        description: Response format (query param, not Accept).
        default: json

  # ── Group A — Action API: entity search ──────────────────────────
  - name: searchEntities
    via: paginate
    path: /w/api.php
    accept: json
    pagination:
      style: offset-limit
      itemsPath: search
      pageParam: continue
      pageSizeParam: limit
      pageSize: 20
    params:
      action:
        description: Wikidata action module — entity search (wbsearchentities).
        default: wbsearchentities
      search:
        description: Query matched against entity labels and aliases (required).
        required: true
      language:
        description: Language code of the search query/surfaces (required).
        required: true
      type:
        description: Entity type to search — item, property, lexeme, form, or sense.
        default: item
      strictlanguage:
        description: When true, only match the exact requested language.
      limit:
        description: Max results per page.
        default: 20
      format:
        description: Response format (json).
        default: json

  # ── Group B — Action API: claims retrieval ───────────────────────
  - name: getClaims
    via: restGet
    path: /w/api.php
    accept: json
    params:
      action:
        description: Wikidata action module — claims retrieval (wbgetclaims).
        default: wbgetclaims
      entity:
        description: Entity ID whose claims to fetch, e.g. Q42 (required).
        required: true
      property:
        description: Filter to a single property, e.g. P569.
      rank:
        description: Filter by rank — deprecated, normal, or preferred.
      format:
        description: Response format (json).
        default: json

  # ── Group C — REST API: item retrieval ───────────────────────────
  - name: getItemREST
    via: restGet
    path: /w/rest.php/wikibase/v1/entities/items/{item_id}
    accept: json

  # ── Group D — REST API: item statements ──────────────────────────
  - name: getItemStatements
    via: restGet
    path: /w/rest.php/wikibase/v1/entities/items/{item_id}/statements
    accept: json
    params:
      property:
        description: Filter to a single property, e.g. P569.

  # ── Group E — REST API: property retrieval ───────────────────────
  - name: getPropertyREST
    via: restGet
    path: /w/rest.php/wikibase/v1/entities/properties/{property_id}
    accept: json

  # ── Group F — REST API: property statements ──────────────────────
  - name: getPropertyStatements
    via: restGet
    path: /w/rest.php/wikibase/v1/entities/properties/{property_id}/statements
    accept: json
    params:
      property:
        description: Filter to a single property, e.g. P1628.

  # ── Group G — REST API: search ───────────────────────────────────
  - name: searchItemsREST
    via: paginate
    path: /w/rest.php/wikibase/v1/search/items
    accept: json
    pagination:
      style: offset-limit
      itemsPath: results
      pageParam: offset
      pageSizeParam: limit
      pageSize: 20
    params:
      q:
        description: Search query against item labels/aliases (required).
        required: true
      language:
        description: Language code of the search surfaces (required).
        required: true
      limit:
        description: Max results per page.
        default: 20
  - name: searchPropertiesREST
    via: paginate
    path: /w/rest.php/wikibase/v1/search/properties
    accept: json
    pagination:
      style: offset-limit
      itemsPath: results
      pageParam: offset
      pageSizeParam: limit
      pageSize: 20
    params:
      q:
        description: Search query against property labels/aliases (required).
        required: true
      language:
        description: Language code of the search surfaces (required).
        required: true
      limit:
        description: Max results per page.
        default: 20
---
# Wikidata — Entity API (G6: non-Latin scripts)

Wikidata exposes entity data with **no auth**. Wikidata content is **CC0**
(public domain).

## Operations

### `getEntity` — fetch entity labels in multiple scripts

`GET /w/api.php?action=wbgetentities&ids=Q42&props=labels&languages=zh|ar|ru|en&format=json`
returns a **language-keyed** shape:

```json
{
  "entities": { "Q42": { "labels": {
    "zh": { "value": "道格拉斯·亞當斯" },
    "ar": { "value": "دوغلاس آدمز" },
    "ru": { "value": "Дуглас Адамс" }
  }}},
  "success": 1
}
```

## How G6 fires

One body carries **CJK + Arabic + Cyrillic** text — the only candidate that
stresses real UTF-8 decode of non-Latin scripts (BOE/DNB are UTF-8 Latin).
The shape is a dict-keyed nesting (`entities.{Qid}.labels.{lang}.value`), not
a flat array — a non-list (entity fetch) op that stresses `parseResponse`'s
charset path and non-tabular access.

## Additional read operations

### Action API — entity search & claims

- `searchEntities` (Action `wbsearchentities`) — match entities by label/alias; paged
  via the integer `continue` offset (`limit` default 20). Returns `{ search: [...],
  search-continue: N }`.
- `getClaims` (Action `wbgetclaims`) — all statements (claims) for an entity as a
  `{ P31: [...], P569: [...] }` property→array map; optional `property` / `rank` filters.

### REST API — items & properties

- `getItemREST` — full Item (`labels`, `descriptions`, `aliases`, `sitelinks`,
  `statements`) as flat string maps (REST native shape, no wrapper objects).
- `getPropertyREST` — full Property (plus `data_type`).
- `getItemStatements` / `getPropertyStatements` — statement-only sub-resources,
  same flat `property→array` map as `getClaims` but without the rest of the entity.
  Optional `property` filter.

### REST API — search

- `searchItemsREST` / `searchPropertiesREST` — label/alias search, paged
  (`offset`/`limit`, default 20). Returns `{ results: [...] }`.

> Path params (`{item_id}`, `{property_id}`) are inferred from the path token and are
> **not** re-declared in `params`. Statement sub-resources, item/property sub-resources
> (labels, descriptions, sitelinks) are covered by the full `getItemREST` /
> `getPropertyREST` responses.

## Notes

- Iterate over whatever `labels` keys the response returns — do not hard-depend
  on a specific language label being present (the `en` label for Q42 was
  transiently absent in one probe; the G6 axis is satisfied by the non-Latin
  scripts regardless).
- `languages` is pipe-separated; pass `zh|ar|ru|en` to fetch multiple scripts
  in one response.

## Terms

Wikidata content is CC0 (public domain). <https://www.wikidata.org/wiki/Wikidata:Licensing>
