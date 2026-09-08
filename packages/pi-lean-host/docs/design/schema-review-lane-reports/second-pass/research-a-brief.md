# Research: pi-lean-host guide-schema review — AUTH axes (research-a)

Method note: questions worked in priority order; each verified against primary docs
(official provider documentation first, community wrappers only where the official doc
is inaccessible). All claims checked on read-only GET endpoints.

---

## Q1 — Prominent read-only API requiring OAuth2 Bearer AND a separate api-key-style credential (query param or path token) on the SAME endpoint?

**VERDICT: REFUTED** (strict form) — with a documented header-form near-miss worth recording.

Findings:

1. **Etsy Open API v3 requires two credentials simultaneously — but both are headers.**
   Official auth page: "The Etsy Open API requires two credentials: an API key for app
   authentication, and an OAuth 2.0 token for user authorization on scoped endpoints."
   The API key is mandatory on *every* request: "Every request to a v3 endpoint must
   include an `x-api-key` header containing your *keystring* and *shared secret*
   separated by a colon." The OAuth 2.0 token is additionally required for scoped
   (private-data) endpoints. So a read GET on a scoped Etsy endpoint carries
   `x-api-key: <key>:<secret>` AND `Authorization: Bearer <token>` simultaneously.
   However, the second credential is a request **header**, not a query param or path
   token — so Etsy does not satisfy Q1's strict criterion.
   [Etsy Authentication](https://developers.etsy.com/documentation/essentials/authentication/)

2. **Amadeus uses OAuth OR key-to-token exchange, never both on the endpoint.**
   Official guide: "Amadeus for Developers uses OAuth to authenticate access requests.
   OAuth generates an access token which grants the client permission to access a
   protected resource." The API key/secret are exchanged once for the token
   (`POST /v1/security/oauth2/token`); no `apikey` param rides on API calls. The
   suspected historical layering does not exist in current docs.
   [Amadeus authorization guide](https://developers.amadeus.com/self-service/apis-docs/guides/developer-guides/API-Keys/authorization/)

3. **Honest negative search.** Across the suggested travel/enterprise class (Amadeus,
   Sabre, Expedia Rapid, Skyscanner) and the broader social/commerce API space
   (Twitch, IGDB, OpenSubtitles, Stack Exchange, Google/YouTube, Firebase, Zendesk,
   HubSpot), no documented currently-live public read endpoint was found requiring an
   OAuth2 `Authorization: Bearer` **plus** a second credential delivered as a **query
   parameter or path token** simultaneously. The recurring real-world "two credentials"
   pattern is Bearer + a second *header* (Etsy `x-api-key`; Twitch/IGDB `Client-Id`;
   OpenSubtitles `Api-Key`) — all expressible today as oauth2 `secretRefs` (the store
   can hold the second header's value), so none of them is blocked by the schema.

**Schema implication:** Adding `secretQueryRefs`/`secretPathRefs`/literal `headers` to
the oauth2 union member remains a speculative watch item, not a P2 — no found recipe
class is blocked today; the only real dual-credential pattern (Bearer + second header)
is already expressible via `secretRefs`.

---

## Q2 — Prominent documentation/data/archive/scholarly/government API requiring request-derived credentials (HMAC signature, SigV4-style, or RFC 7616 digest) on read-only GETs?

**VERDICT: CONFIRMED (HMAC class) — HathiTrust Data API.**

Findings:

1. **HathiTrust Data API (scholarly digital library) uses OAuth 1.0 HMAC-signed GETs.**
   The official spec's own revision line: "HathiTrust Data API Version 0.9,
   10 September 2012 - Updated to reflect OAuth 1.0 signed URL requirements, Key
   Generation Service and Web Client" (v2, revised 26 May 2015, is current). The
   official Data API page confirms programmatic access is via a Key Generation Service
   access key, not plain headers. HathiTrust blocked direct fetch of the PDF (HTTP 403);
   the revision line is quoted verbatim from the official hathitrust.org PDF as surfaced
   in search, and the full v2 PDF was retrieved via the Internet Archive but is binary.
   [HathiTrust Data API page (archived official)](https://web.archive.org/web/20191121232143/https://www.hathitrust.org/data_api)
   [Official v0.9 spec PDF (revision line)](https://www.hathitrust.org/sites/www.hathitrust.org/documents/hathitrust-data-api.pdf)
   [Official v2 spec PDF](https://www.hathitrust.org/documents/hathitrust-data-api-v2_20150526.pdf)

2. **The signed GETs are exactly the read-only resources a recipe would target.**
   A widely-used library wrapper implements the Data API reads — `getmeta`,
   `getstructure`, `getpagemeta`, `getaggregate` (full volume package), `getpageimage`,
   `getpageocr`, `getpagecoordocr` — all plain HTTP GETs, authenticated by attaching an
   OAuth 1.0 signer to the session: `OAuth1(client_key=client_key,
   client_secret=client_secret, signature_type='query')` — i.e., HMAC-SHA1 signature
   parameters appended to the GET URL, with the secure base URL used "for access to
   restricted content." Public-domain volumes are open; restricted-content reads
   require the signed request.
   [hathitrust-api data_api.py](https://github.com/rlmv/hathitrust-api/blob/master/hathitrust_api/data_api.py)

3. **Digest auth (RFC 7616): still none found at primary-source quality.** Searches
   surfaced only the RFC itself and commentary/guides; no prominent public read API
   documentation was found mandating HTTP Digest on GETs. The recorded gap ("no public
   read API doc rose to primary-source quality") remains accurately closed as
   INCONCLUSIVE-by-absence for digest. [RFC 7616](https://www.rfc-editor.org/info/rfc7616/)

4. **Internet Archive S3-like API does NOT trigger the seam** — checked as the other
   in-class candidate: its auth is a credential header (`Authorization: LOW key:secret`),
   and SigV4-style signing is not documented as mandatory for reads.
   [IA ias3 docs](https://archive.org/developers/ias3.html)

**Schema implication:** The P1 seam note ("build request-derived credentials when a
caritas recipe targets a signed GET") is live — HathiTrust Data API is squarely in the
documentation/archives/scholarly corpus class and requires OAuth1-style HMAC query
signatures on read GETs; the seam should be designed now (shape it toward signed-query /
signed-header reads, e.g. `signedRequest` auth kind), not deferred as trading/AWS-only.

---

## Sources

Kept:
- Etsy Open API v3 — Authentication (developers.etsy.com) — official; the one documented dual-credential read API found.
- Amadeus for Developers — API Keys Authorization (developers.amadeus.com) — official; refutes the suspected key+OAuth layering.
- HathiTrust Data API official page + spec PDFs (hathitrust.org / wayback copy) — primary for OAuth1 HMAC-signed GET requirement.
- rlmv/hathitrust-api `data_api.py` (GitHub) — concrete read-GET surface + OAuth1 query-signature implementation; corroborates the official spec.
- IA ias3 docs (archive.org/developers/ias3.html) — official; eliminates the other in-class candidate.
- RFC 7616 (rfc-editor.org) — primary; confirms no public-API doc evidence for digest.

Dropped:
- Medium/blog posts on digest auth and Bearer-vs-API-key comparisons — commentary, no provider docs.
- DeepWiki/oauth-sign pages — library internals, not API-provider docs.
- Stack Overflow threads — secondary Q&A, not documentation.

## Gaps

- The HathiTrust v2 PDF text could not be extracted (hathitrust.org 403s plain fetches;
  wayback serves raw PDF bytes). The HMAC requirement rests on the spec's official
  revision line + the library wrapper, not a verbatim requirement paragraph. Next step:
  fetch the PDF with a PDF-capable reader, or verify the secure Data API base URL
  (`babel.hathitrust.org/cgi/htd/...`) live with/without signed params.
- Q1's negative result covers prominent/visible APIs; a long-tail enterprise API could
  still exist. Marked speculative per the question's own instruction.

## Skipped / budget

None skipped — both questions were investigated to a verdict within budget
(~9 searches/fetches total; HathiTrust PDF access consumed the largest share).
