---
kind: api
domains:
  - services.dnb.de
shortName: DNB
icon: 🇩🇪
apiHost: https://services.dnb.de
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
verified: "2026-07-18"
docs: https://www.dnb.de/EN/Professionell/Metadatendienste/Datenbezug/SRU/sru_node.html
operations:
  - name: searchZdb
    via: paginate
    path: /sru/zdb
    accept: xml
    pagination:
      style: offset-limit
      itemsPath: searchRetrieveResponse.records.record
      pageParam: startRecord
      pageSizeParam: maximumRecords
      pageSize: 2
    params:
      version:
        description: SRU protocol version.
        default: "1.1"
      operation:
        description: SRU operation.
        default: searchRetrieve
      query:
        description: >
          CQL query. The ZDB catalog requires a **bare term**
          (e.g. `Wasser`), not an indexed `field=value` query — indexed
          queries return SRU diagnostic `info:srw/diagnostic/1/16`
          ("Unsupported index").
        required: true
      recordSchema:
        description: Record schema (`oai_dc` for Dublin Core; `MARCXML` also available).
        default: oai_dc
  - name: searchDnb
    via: paginate
    path: /sru/dnb
    accept: xml
    pagination:
      style: offset-limit
      itemsPath: searchRetrieveResponse.records.record
      pageParam: startRecord
      pageSizeParam: maximumRecords
      pageSize: 2
    params:
      version:
        description: SRU protocol version.
        default: "1.1"
      operation:
        description: SRU operation.
        default: searchRetrieve
      query:
        description: >
          CQL query. The DNB main catalogue supports **indexed** queries
          (e.g. `SW=Goethe`) as well as bare terms (e.g. `Leipzig`).
        required: true
      recordSchema:
        description: Record schema (`oai_dc` for Dublin Core; `MARC21-xml` also available).
        default: oai_dc
  - name: searchDma
    via: paginate
    path: /sru/dnb.dma
    accept: xml
    pagination:
      style: offset-limit
      itemsPath: searchRetrieveResponse.records.record
      pageParam: startRecord
      pageSizeParam: maximumRecords
      pageSize: 2
    params:
      version:
        description: SRU protocol version.
        default: "1.1"
      operation:
        description: SRU operation.
        default: searchRetrieve
      query:
        description: >
          CQL query. German Music Archive catalogue; supports indexed
          queries (e.g. `SW=Beethoven`) and bare terms (e.g. `Leipzig`).
        required: true
      recordSchema:
        description: Record schema (`oai_dc` for Dublin Core; `MARC21-xml` also available).
        default: oai_dc
  - name: searchAuthorities
    via: paginate
    path: /sru/authorities
    accept: xml
    pagination:
      style: offset-limit
      itemsPath: searchRetrieveResponse.records.record
      pageParam: startRecord
      pageSizeParam: maximumRecords
      pageSize: 2
    params:
      version:
        description: SRU protocol version.
        default: "1.1"
      operation:
        description: SRU operation.
        default: searchRetrieve
      query:
        description: >
          CQL query. GND Integrated Authority File; supports indexed
          queries (e.g. `WOE=Goethe`) and bare terms.
        required: true
      recordSchema:
        description: Record schema (`oai_dc` for Dublin Core; `MARC21-xml` also available).
        default: oai_dc
      BBG:
        description: >
          Optional entity-type restriction (`Tp` person, `Tg` geographical
          entity, `Tf` corporate body, `Ts` subject term, `Tu` work,
          `Tb` congress/event).
  - name: oaiListRecords
    via: paginate
    path: /oai/repository
    accept: xml
    pagination:
      style: resumptionToken
      itemsPath: OAI-PMH.ListRecords.record
      tokenParam: resumptionToken
      tokenPath: OAI-PMH.ListRecords.resumptionToken.#text
      totalCountPath: OAI-PMH.ListRecords.resumptionToken.@_completeListSize
    params:
      verb:
        description: OAI-PMH verb.
        default: ListRecords
      metadataPrefix:
        description: Metadata format prefix (e.g. `oai_dc`, `MARC21-xml`). Required on the first request; omitted on subsequent requests per the OAI-PMH resumptionToken rule.
        default: oai_dc
      set:
        description: Optional set specifier to restrict the harvest.
      from:
        description: Optional UTC date — lower bound (YYYY-MM-DD).
      until:
        description: Optional UTC date — upper bound (YYYY-MM-DD).
  - name: oaiListIdentifiers
    via: paginate
    path: /oai/repository
    accept: xml
    pagination:
      style: resumptionToken
      itemsPath: OAI-PMH.ListIdentifiers.header
      tokenParam: resumptionToken
      tokenPath: OAI-PMH.ListIdentifiers.resumptionToken.#text
      totalCountPath: OAI-PMH.ListIdentifiers.resumptionToken.@_completeListSize
    params:
      verb:
        description: OAI-PMH verb.
        default: ListIdentifiers
      metadataPrefix:
        description: Metadata format prefix (e.g. `oai_dc`, `MARC21-xml`). Required on the first request; omitted on subsequent requests per the OAI-PMH resumptionToken rule.
        default: oai_dc
      set:
        description: Optional set specifier to restrict the harvest.
      from:
        description: Optional UTC date — lower bound (YYYY-MM-DD).
      until:
        description: Optional UTC date — upper bound (YYYY-MM-DD).
  - name: oaiIdentify
    via: restGet
    path: /oai/repository
    accept: xml
    params:
      verb:
        description: OAI-PMH verb.
        default: Identify
  - name: oaiListSets
    via: restGet
    path: /oai/repository
    accept: xml
    params:
      verb:
        description: OAI-PMH verb.
        default: ListSets
  - name: oaiListMetadataFormats
    via: restGet
    path: /oai/repository
    accept: xml
    params:
      verb:
        description: OAI-PMH verb.
        default: ListMetadataFormats
  - name: oaiGetRecord
    via: restGet
    path: /oai/repository
    accept: xml
    params:
      verb:
        description: OAI-PMH verb.
        default: GetRecord
      identifier:
        description: OAI identifier of the record (e.g. `oai:dnb.de/authorities/118540238`).
        required: true
      metadataPrefix:
        description: Metadata format (e.g. `MARC21-xml`, `oai_dc`).
        default: MARC21-xml
---
# DNB — German National Library SRU / ZDB Catalog

The DNB SRU endpoint exposes the ZDB (Zeitschriftendatenbank) serials catalog
with **no authentication**. Metadata is freely reusable; the SRU interface is
explicitly documented for programmatic retrieval.

## Operations

### `searchZdb` — SRU search (XML response)

`GET /sru/zdb?version=1.1&operation=searchRetrieve&query=Wasser&maximumRecords=2&recordSchema=oai_dc`
returns a **`text/xml; charset=UTF-8`** body. The transport decodes the
charset from `Content-Type` and `parseResponse` runs the XML→JSON conversion
via `fast-xml-parser`:

```xml
<searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">
  <numberOfRecords>1915</numberOfRecords>
  <records>
    <record>
      <recordSchema>oai_dc</recordSchema>
      <recordData><dc ...><dc:title>Informationen / Wasser- und Schifffahrtsdirektion Mitte …</dc:title></dc></recordData>
      <recordPosition>1</recordPosition>
    </record>
  </records>
  <nextRecordPosition>3</nextRecordPosition>
</searchRetrieveResponse>
```

`itemsPath: searchRetrieveResponse.records.record` resolves against the XML-converted JSON. Pagination
is SRU offset-limit via `startRecord` / `maximumRecords`.

### `oaiListRecords` / `oaiListIdentifiers` — OAI-PMH harvesting

`GET /oai/repository?verb=ListRecords&metadataPrefix=oai_dc` returns an
OAI-PMH 2.0 XML response. The first page includes the initial batch of
records plus a `<resumptionToken completeListSize="N" cursor="M">token</resumptionToken>`
element. Subsequent pages are fetched by echoing the token:
`?verb=ListRecords&resumptionToken=TOKEN`.

The `resumptionToken` pagination style reads the token from
`OAI-PMH.ListRecords.resumptionToken.#text` (the `.#text` suffix is needed
because `fast-xml-parser` nests text under `#text` when the element carries
attributes like `completeListSize`/`cursor`). Items are at
`OAI-PMH.ListRecords.record` (ListRecords) or `OAI-PMH.ListIdentifiers.header`
(ListIdentifiers). Pagination stops when the `resumptionToken` element is
absent or empty.

**⚠ OAI-PMH resumptionToken rule (known caveat):** the OAI-PMH spec
requires that a `resumptionToken` be the only argument besides `verb` on
subsequent requests. The current paginator sends all original params
(`metadataPrefix`, `from`, `until`, `set`) plus the token on every page.
Some OAI-PMH servers reject requests that include extra arguments with a
`badResumptionToken` error. If DNB enforces this strictly, a paginator
enhancement to drop non-`verb` params on resume is needed. The token itself
encodes all harvest state, so the extra params are redundant but not
harmless on strict servers.

## Notes & schema gaps (escape-valve evidence)

- **Bare CQL term required:** the ZDB catalog rejects indexed queries
  (`Titel=Test`, `dnb.ti=Wasser`) with SRU diagnostic
  `info:srw/diagnostic/1/16` ("Unsupported index"). Use a bare term
  (`query=Wasser`). Verified 2026-07-18.
- **Charset is UTF-8** (not non-UTF-8). The axis-B criterion is "XML **and/or**
  non-UTF-8"; DNB covers the XML half. The transport's charset-decoding path is
  still exercised because every response carries `Content-Type: text/xml;
  charset=UTF-8` that must be decoded before `fast-xml-parser` runs.
- **Single-record edge:** when a page returns exactly one record,
  `fast-xml-parser` yields `searchRetrieveResponse.records.record` as an
  **object** rather than an array. The built-in `resolveJsonPath` then sees
  a non-array and stops pagination. With `maximumRecords: 2` and a broad query (e.g. `Wasser` → 1915
  hits) pages are full; the edge only bites with 1-result pages. Noted as a
  `parseResponse` generalization target (array-normalization).

## Terms

DNB re-use terms:
<https://www.dnb.de/EN/Professionell/Metadatendienste/Datenbezug/SRU/sru_node.html>
