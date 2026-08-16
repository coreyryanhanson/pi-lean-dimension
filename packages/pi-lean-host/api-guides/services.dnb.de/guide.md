---
kind: api
schemaVersion: 0
domains:
  - dnb.de
shortName: DNB
icon: 🇩🇪
apiHost: https://services.dnb.de
auth:
  kind: none
responseShape:
  format: xml
  charset: utf-8
operations:
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
        default: ListRecords
      metadataPrefix:
        default: oai_dc
---
# DNB OAI-PMH (synthetic axis guide) — resumptionToken + XML

Synthetic coverage fixture for the `resumptionToken` pagination style and
`xml-parsing`, plus `exec-paginate` and `transport`. There is **no live
endpoint** — exercised only against mocked transport.

## Operations

- **`oaiListRecords`** (`paginate`, `resumptionToken`, XML) — echoes the
  opaque `resumptionToken` from each page into the next request; a terminal
  token (no `#text`) stops pagination. `totalCountPath` surfaces
  `@_completeListSize` as `serverTotal`.
