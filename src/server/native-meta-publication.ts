import {
  nativeMetaPublication,
  sameNativeMetaIdentity,
  type NativeMetaIdentity,
  type NativeMetaPublication,
} from "../lit/runtime/native-meta-sidecar";

/** Explicit build receipts; the selected object must match this page's pinned catalogue. */
export function nativeMetaPublicationFor(identity: NativeMetaIdentity): NativeMetaPublication | undefined {
  const json = process.env.NATIVE_META_REFERENCE_RECEIPTS_JSON;
  if (!json) return undefined;
  if (Buffer.byteLength(json) > 65536) throw new Error("Native Meta receipt configuration exceeds byte limit");
  const values: unknown = JSON.parse(json);
  if (!Array.isArray(values)) throw new Error("Native Meta receipt configuration must be an array");
  let selected: NativeMetaPublication | undefined;
  for (const value of values) {
    const publication = nativeMetaPublication(value);
    if (!publication) throw new Error("Native Meta build receipt is invalid or unpublished");
    if (!sameNativeMetaIdentity(publication, identity)) continue;
    if (selected) throw new Error("Native Meta build has multiple receipts for one catalogue pin");
    selected = publication;
  }
  return selected;
}
