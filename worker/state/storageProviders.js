// worker/state/storageProviders.js
//
// Registry of S3-compatible "internal" storage providers (ArvanCloud today,
// possibly Asiatech or others later). Nothing here talks to any provider's
// API directly — that happens in actions/common/storage_upload.py, on the
// GitHub Actions side. This file only defines *which providers exist* and
// their static connection defaults, so the rest of the Worker (menus,
// handlers, quota logic) can stay provider-agnostic: they work with a
// providerId string ("arvan", "asiatech", ...) and never hardcode "arvan"
// outside of this list and the one default below.
//
// Adding a new provider later is meant to be exactly this:
//   1. add an entry to PROVIDERS below
//   2. (optional) add its secret-backed admin defaults in wrangler/GitHub secrets
//   3. actions/common/storage_upload.py already handles any S3-compatible
//      provider generically (endpoint/access/secret/bucket), so no change
//      needed there unless the provider needs non-S3 auth.
//
// A user's chosen provider is stored per-key-set (see state/users.js:
// arvanAccessKey/arvanSecretKey/... today, providerId-scoped fields as more
// providers are added), not here — this module is just the static catalog.

export const PROVIDERS = {
  arvan: {
    id: "arvan",
    label: "آروان‌کلاد",
    // Standard ArvanCloud Object Storage (S3-compatible) endpoint. Region
    // varies by the bucket's chosen datacenter; ir-thr-at1 (Tehran) is
    // ArvanCloud's default/most common region. If a bucket lives in a
    // different region, override via env.ARVAN_ENDPOINT (Worker/Actions
    // secret) rather than editing this default.
    defaultEndpoint: "https://s3.ir-thr-at1.arvanstorage.ir",
    defaultBucket: "my-files-telegram",
    // Where a user with no personal key yet can go create Access/Secret
    // keys for ArvanCloud Object Storage themselves.
    keyGuideUrl: "https://npanel.arvancloud.ir/profile/api-keys",
    keyGuideTextFa:
      "🇮🇷 برای گرفتن کلید آروان:\n" +
      "1. وارد پنل ابری آروان بشید: https://npanel.arvancloud.ir/profile/api-keys\n" +
      "2. یک Access Key/Secret Key جدید بسازید (یا از قبلی استفاده کنید)\n" +
      "3. یک Bucket در Object Storage بسازید (یا از باکت موجودتون استفاده کنید)\n" +
      "4. Access Key، Secret Key، نام Bucket رو برای ربات بفرستید",
  },
  // Placeholder for a future provider — kept commented as a template, not
  // registered, so it has zero effect until it's actually wired up:
  //
  // asiatech: {
  //   id: "asiatech",
  //   label: "آسیاتک",
  //   defaultEndpoint: "https://s3.asiatech.example",
  //   defaultBucket: null, // admin must set one, no sane global default
  //   keyGuideUrl: "https://example.asiatech.ir/keys",
  //   keyGuideTextFa: "...",
  // },
};

// The provider offered as "🇮🇷 داخلی" today. When a second provider is
// added, this can become a per-admin setting instead of a constant — but
// until then, keeping a single constant avoids inventing UI for a choice
// nobody can make yet.
export const DEFAULT_INTERNAL_PROVIDER_ID = "arvan";

export function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

/**
 * Builds the field names used to store a given provider's personal key set
 * on a user record (see state/users.js). Centralised here so a new
 * provider doesn't require touching users.js's shape by hand — e.g.
 * providerKeyFields("arvan") -> { accessKey: "arvanAccessKey", ... }.
 */
export function providerKeyFields(providerId) {
  return {
    accessKey: `${providerId}AccessKey`,
    secretKey: `${providerId}SecretKey`,
    endpoint: `${providerId}Endpoint`,
    bucket: `${providerId}Bucket`,
  };
}
