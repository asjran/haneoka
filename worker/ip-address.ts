export interface IpDetails {
  city: string | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  postalCode: string | null;
  timezone: string | null;
  asn: number | null;
  asOrganization: string | null;
}

export interface RequestIpMetadata extends IpDetails {
  countryCode: string | null;
  ipAddress: string | null;
  regionCode: string | null;
  regionName: string | null;
}

const validIpv4 = (value: string): boolean => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part,
    )
  );
};

const validIpv6 = (value: string): boolean => {
  if (value.length < 2 || value.length > 45 || !value.includes(":") || !/^[0-9a-f:.]+$/iu.test(value)) return false;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]");
  } catch {
    return false;
  }
};

const validIpAddress = (value: string): boolean => validIpv4(value) || validIpv6(value);

const trustedCf = (request: Request): object | null =>
  request.cf && typeof request.cf === "object" && !request.headers.has("CF-Worker") ? request.cf : null;

const headerIpAddress = (request: Request): string | null => {
  // When Cloudflare Pseudo IPv4 overwrites CF-Connecting-IP, this header keeps
  // the original IPv6 address. Both headers are set by Cloudflare, not read
  // from X-Forwarded-For.
  // Same-zone Worker subrequests can rewrite x-real-ip/CF-Connecting-IP.
  // Leave their visit IP unknown rather than treating it as direct ingress.
  if (!trustedCf(request)) return null;
  const candidates = [request.headers.get("CF-Connecting-IPv6"), request.headers.get("CF-Connecting-IP")];
  for (const candidate of candidates) {
    const value = candidate?.trim() ?? "";
    if (value && validIpAddress(value)) return value;
  }
  return null;
};

const cfString = (request: Request, key: string): string | null => {
  const cf = trustedCf(request);
  const value = cf ? Reflect.get(cf, key) : null;
  return boundedMetadataText(value);
};

export const requestIpMetadata = (request: Request): RequestIpMetadata => {
  const rawCountryCode = cfString(request, "country")?.toUpperCase() ?? null;
  const countryCode =
    rawCountryCode && (/^[A-Z]{2}$/u.test(rawCountryCode) || rawCountryCode === "T1") ? rawCountryCode : null;
  const rawRegionCode = cfString(request, "regionCode")?.toUpperCase() ?? null;
  const regionCode = countryCode && rawRegionCode && /^[A-Z0-9-]{1,16}$/u.test(rawRegionCode) ? rawRegionCode : null;
  const rawRegionName = cfString(request, "region");
  const regionName = rawRegionName && [...rawRegionName].length <= 120 ? rawRegionName : null;
  return {
    ...normalizeIpDetails(trustedCf(request)),
    countryCode,
    ipAddress: headerIpAddress(request),
    regionCode,
    regionName,
  };
};

const boundedMetadataText = (value: unknown, maximum = 120): string | null => {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  return text && [...text].length <= maximum && !/[\p{Cc}\p{Cs}\uFFFD]/u.test(text) ? text : null;
};

const coordinate = (value: unknown, maximum: number): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d{1,3}(?:\.\d{1,12})?$/u.test(value)))
    return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : null;
};

const normalizeIpDetails = (value: unknown): IpDetails => {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const read = (name: string): unknown => Reflect.get(data, name);
  const continent = boundedMetadataText(read("continent"), 2);
  const asn = read("asn");
  return {
    city: boundedMetadataText(read("city")),
    continent: continent && /^[A-Z]{2}$/u.test(continent) ? continent : null,
    latitude: coordinate(read("latitude"), 90),
    longitude: coordinate(read("longitude"), 180),
    postalCode: boundedMetadataText(read("postalCode"), 32),
    timezone: boundedMetadataText(read("timezone"), 128),
    asn: typeof asn === "number" && Number.isSafeInteger(asn) && asn > 0 && asn <= 4_294_967_295 ? asn : null,
    asOrganization: boundedMetadataText(read("asOrganization"), 200),
  };
};

export const ipDetailsJson = (metadata: RequestIpMetadata): string => JSON.stringify(normalizeIpDetails(metadata));

export const readIpDetails = (value: string | null): IpDetails => {
  try {
    return normalizeIpDetails(value ? JSON.parse(value) : null);
  } catch {
    return normalizeIpDetails(null);
  }
};

export const publicIpLocation = (countryCode: string | null): { countryCode: string } | null =>
  countryCode && /^[A-Z]{2}$/u.test(countryCode) && countryCode !== "XX" ? { countryCode } : null;

// Authenticated dynamic requests are sampled once per minute; an IP change is
// recorded immediately. The session predicate and monotonic UPSERT also apply
// when a signed cookie cache is still present after durable revocation.
export const recordAuthenticatedVisit = async (
  request: Request,
  env: Env,
  userId: string,
  token: string,
  visitedAt = Date.now(),
): Promise<void> => {
  const ip = requestIpMetadata(request);
  await env.DB.prepare(
    `INSERT INTO community_user_last_visit
       (user_id, visited_at, ip_address, ip_country_code, ip_region_code, ip_region_name, ip_details_json)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM "session" AS active_session
       JOIN community_profile AS profile ON profile.user_id = active_session.userId
       WHERE active_session.userId = ? AND active_session.token = ?
         AND (strftime('%s', active_session.expiresAt) * 1000) > ?
         AND profile.status <> 'deleted'
         AND NOT EXISTS (
           SELECT 1 FROM community_user_restriction
           WHERE user_id = profile.user_id AND kind = 'sign_in' AND revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
         )
     )
     ON CONFLICT(user_id) DO UPDATE SET
       visited_at = excluded.visited_at, ip_address = excluded.ip_address,
       ip_country_code = excluded.ip_country_code, ip_region_code = excluded.ip_region_code,
       ip_region_name = excluded.ip_region_name, ip_details_json = excluded.ip_details_json
     WHERE excluded.visited_at > community_user_last_visit.visited_at
       AND (excluded.visited_at - community_user_last_visit.visited_at >= 60000
            OR excluded.ip_address IS NOT community_user_last_visit.ip_address)`,
  )
    .bind(
      userId,
      visitedAt,
      ip.ipAddress,
      ip.countryCode,
      ip.regionCode,
      ip.regionName,
      ipDetailsJson(ip),
      userId,
      token,
      visitedAt,
      visitedAt,
    )
    .run();
};
