# Paid product readiness

Applies to the paid parts of public and private products. Use the project's existing billing
and delivery tools; record which checks apply to its platforms and sales channels.

## Commercial facts

- Compare the product catalogue, deployed pricing page and provider's active offer: amount,
  currency, recurring interval or one-time purchase, tax treatment, trial and checkout URL.
- Check free limits, eligibility, device limits and cancellation/refund promises against the
  product's actual access rules. A catalogue edit does not change a payment provider.
- Default to read-only provider queries. Do not create a purchase, customer or checkout session,
  change a price, or log in to an owner-only service just to produce a readiness report.
- Name unavailable checks explicitly. An API that exposes a price but not trial or tax details
  cannot prove those details; missing credentials or observations are not a passing result.

## Delivery and access

- Use [delivery evidence](release.md): a verified production deployment for a web product,
  or the published build and channel for a desktop product. Check each supported platform.
- Verify the relevant install, sign-in, upgrade and cancellation paths. Exercise entitlement
  grants, renewals, expiry and refunds through the project's existing test environment or
  fixtures; distinguish this from a verified production payment and access grant.
- Preserve owner-only release steps. Prepare notes and images with the change, then publish
  website claims and announcements after the referenced build or deployment is available.
- Follow [product content](product-content.md) for documentation and reproducible demonstrations.

## Evidence and reporting

Record the product, delivered revision, platform/channel, observation time, sources, checked
fields, mismatches and unavailable checks. Keep the result with the existing release evidence;
do not create a second product catalogue or a new release engine.

When reporting commercial results, use product-scoped aggregates from existing provider data.
Define the time window and object dates: a checkout, trial start, successful payment and refund
are different events. Do not count unrelated account products or expose customer records.
Missing access is unknown, not zero; website clicks do not prove purchases or campaign attribution.

Provide these verified facts to the maintainer's separate publishing process. Promotional
campaigns belong there. Product-owned account, consent, service-migration and billing notices
keep their own delivery rules and are not social promotion.
