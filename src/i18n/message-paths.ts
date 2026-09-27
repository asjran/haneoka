export const catalogLookupKeys = (key: string): readonly string[] => {
  const compatibility = key === "tgwCard" ? "catalogCompat.tgw.card" : `catalogCompat.${key}`;
  return compatibility === key ? [key] : [key, compatibility];
};
