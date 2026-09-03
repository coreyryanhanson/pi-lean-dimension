---
kind: api
schemaVersion: 1
domains:
  - stripe.com
shortName: Stripe
icon: 💳
apiHost: https://api.stripe.com
auth:
  # Auth realism is not this fixture's job — the static-key and oauth2 axes
  # are carried by github and twitch/twitch-user. Grounding is: the live
  # caritas recipe uses `secretRefs` + a read-only restricted key.
  kind: none
responseShape:
  format: json
  charset: utf-8
pagination:
  style: cursor
  itemsPath: data
  cursorParam: starting_after
  cursorPath: "data[-1].id"
  hasMorePath: has_more
  pageSizeParam: limit
  pageSize: 10
operations:
  - name: listCharges
    via: paginate
    path: /v1/charges
    accept: json
    params:
      customer:
        description: Only return charges for this customer id.
      payment_intent:
        description: Only return charges for this PaymentIntent id.
      created:
        description: >
          Filter by creation date — a UNIX timestamp (bracket-object range
          syntax is not expressible through this recipe).
---
# Stripe (axis guide) — boolean `hasMorePath` exhaustion + derived-id cursor

Axis-guide fixture for the **boolean hasMorePath** axis: Stripe list
endpoints return `{ object: "list", data: [...], has_more: bool }` with
**no cursor field anywhere in the envelope** — the documented manual loop
is "if `has_more` is true, take the last object's id and pass it as
`starting_after`". One op exercises both halves of the exhaustion pattern
in one walk (the list recipe, verbatim from the live-verified caritas
recipe's guide-level pagination block): `cursorPath: "data[-1].id"` derives the cursor,
`hasMorePath: has_more` is the stop-condition field — resolved-falsy stops
cleanly (no wasted past-the-end request, no ceiling ⚠), while absent-never-
stops keeps the pre-exhaustion semantics as the fallback. Also carries
`exec-paginate` (cursor style) and `transport`.

Response payloads are **real** (Stripe `/v1/charges`), captured live and
stripped leaner; the guide is exercised only against mocked transport by
the co-located test. There is **no live endpoint claim** here — the full
live-verified recipe lives in caritas.

## Operations

- **`listCharges`** (`paginate`, cursor) — walks `starting_after` = previous
  page's last charge id; `has_more: false` on a page stops the walk with
  the empty past-the-end page **never fetched** (the one-wasted-request
  Stripe behavior without `hasMorePath` is the contrast the co-located test
  pins). Guide-level pagination: Stripe's list envelope is uniform across
  endpoints, so the block lives at guide level.

## Shape notes

- `has_more` is a real JSON boolean in every observed envelope. The
  truthiness contract (string `"false"` advances, `undefined` never stops)
  is pinned at unit level in `__tests__/axis-units.test.ts` (Axis H); this
  fixture pins the guide-level walk shape.
- `has_more: true` with an exactly-full page is the normal advance case;
  the ceiling ⚠ false-alarm Stripe walks would hit without this field is
  the whole reason the field exists.
