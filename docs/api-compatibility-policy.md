# Senko API Compatibility Policy

Status: **Proposed for operator approval**

This document defines the source-level compatibility rules used while developing the Senko managed inference API. It
does not create a customer commitment, notice period, or service-level agreement until the operator approves those
items and publishes this policy with the production API.

The machine-readable current contract is exposed by the Worker at `GET /openapi.json`. The implementation and OpenAPI
document must change together, and contract tests prevent supported route, authentication, scope, and top-level request
field allowlists from drifting silently.

## Version boundaries

- `/v1/*` is the customer inference API compatibility boundary.
- `/admin/v1/*` is an operator-only provisioning boundary. It is not a customer administration API and may not be
  integrated by customers.
- The OpenAPI `info.version` describes the specification artifact. It does not replace the `/v1` path boundary.
- A change that cannot be made compatibly requires a new major path such as `/v2`; it must not silently change the
  meaning of an existing `/v1` request.

## Compatible changes

The following changes are normally compatible, provided they do not weaken validation or security:

- adding an optional request field;
- adding an optional response field or a new value where the contract explicitly allows an open set;
- adding a new model ID, endpoint, or optional feature;
- adding a new error code without changing the documented HTTP status or error envelope;
- improving validation, latency, availability, routing, or cost within an existing documented semantic boundary;
- changing an internal provider route while keeping the resolved public model contract, regional policy, and published
  price unchanged.

Clients must ignore unknown response fields unless a schema explicitly sets `additionalProperties: false`. Clients must
branch on stable error `code` and HTTP status rather than exact human-readable error messages.

## Breaking changes

The following are breaking and require a new major API boundary or an approved deprecation process:

- removing or renaming a supported endpoint, request field, response field, event type, or model ID;
- making an optional request field required;
- narrowing an accepted field type, enum, tool shape, input modality, output limit, or protocol without a safety or
  abuse emergency;
- changing authentication or required scopes so an existing valid key loses access;
- changing a successful response into an error for previously documented input;
- changing streaming event order or terminal semantics in a way that breaks a conforming client;
- exposing provider-specific IDs where the contract promises Senko-resolved model IDs;
- reusing an existing error code for a materially different condition.

Security fixes may need an accelerated change. The incident commander must record the affected contract, customer
impact, mitigation, and follow-up communication; urgency is not permission to omit the audit trail.

## Model IDs and aliases

- A concrete public model ID is stable for its documented context window, input modalities, protocols, and broad
  behavior class. Provider routing behind it may change only when the adapter contract and release gates still pass.
- `fast` is intentionally a moving alias. The resolved model ID is returned in responses and terminal stream events so
  customers can audit what ran.
- A proposed `fast` target change must be evaluated for quality, latency, context window, tool compatibility, regional
  handling, and price before rollout. Material customer-visible changes require an operator-approved notice and
  rollback plan.
- Removing a concrete model ID follows the approved deprecation process; silently redirecting it to an incompatible
  model is not allowed.

## Proposed deprecation flow

The exact notice period and customer communication channel remain operator decisions. Once approved, every planned
deprecation should:

1. identify the endpoint, field, event, or model and the supported replacement;
2. record affected accounts from content-free metadata only;
3. publish the effective date through the approved customer channel;
4. add standard `Deprecation`, `Sunset`, and documentation `Link` headers where HTTP responses are involved;
5. monitor replacement adoption and support cases by account/request ID, never prompt or output content;
6. prevent new adoption before removal when practical;
7. remove only after the approved notice and exception process is complete;
8. retain the decision, rollout evidence, and rollback result in the release record.

## Release requirements

Before a supported contract change reaches production:

- update `apps/api/src/openapi.ts`, implementation, tests, and `docs/inference-api.md` together;
- classify the change as compatible, deprecated, or breaking and name the reviewer;
- pass static checks, local contract tests, and the verification level required by the release gate;
- test affected real-provider contracts in staging when provider behavior is involved;
- record rollback criteria and the last known good version;
- obtain explicit approval for production deployment and any external customer commitment.

## Approval still required

The operator must decide the customer notice period, emergency exception authority, communication channels, supported
SDK/client window, model-alias notice threshold, and final policy owner. These decisions are tracked in Kanbria under
`人間阿部がやるタスク`.
