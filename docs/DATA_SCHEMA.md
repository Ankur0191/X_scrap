# Normalized post schema

Each output line in `data/output/posts.jsonl` is one JSON object.

| Field | Type | Required | Meaning |
|---|---|---:|---|
| id | string | yes | Stable source post ID |
| authorUsername | string | yes | Lowercase handle without @ |
| text | string | yes | Post text |
| createdAt | ISO-8601 string | yes | Source publication timestamp |
| url | absolute HTTP(S) URL | yes | Canonical post URL |
| language | string or null | no | Source language code |
| metrics | object | no | Source-provided public metrics |
| media | array | no | Source-provided media metadata |
| source | string | no | Authorized acquisition source |
| ingestedAt | ISO-8601 string | generated | Import timestamp |

Never enrich the schema with private, sensitive, or inferred personal data. Preserve provenance and the source's permitted-use restrictions.
