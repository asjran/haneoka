import { teamBuilderDataResponse } from "../src/lib/team-builder/data/response";

export type TeamBuilderCatalogReader = (request: Request) => Promise<Response | null>;
/** Public wrapper reuses the dispatcher's catalog handler, including its server/pin validation. */
export async function handleTeamBuilderData(
  request: Request,
  readCatalog: TeamBuilderCatalogReader,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/api\/v1\/team-builder\/([^/]+)\/?$/u.exec(url.pathname);
  if (!match) return null;
  const error = (status: number, code: string) => Response.json({ error: { code } }, { status });
  if (!["GET", "HEAD"].includes(request.method)) return error(405, "method_not_allowed");
  let server: string;
  try {
    server = decodeURIComponent(match[1]!);
  } catch {
    return error(400, "invalid_server");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(server)) return error(400, "invalid_server");
  const releases = url.searchParams.getAll("release");
  if (releases.length > 1 || (releases[0] !== undefined && !/^r-[a-f0-9]{20}$/u.test(releases[0])))
    return error(400, "invalid_release");
  const prefix = `/api/v1/servers/${encodeURIComponent(server)}/`;
  const pinUrl = new URL(`${prefix}release`, url);
  pinUrl.searchParams.set("projection", "identity");
  if (releases[0]) pinUrl.searchParams.set("release", releases[0]);
  const pin = await readCatalog(new Request(pinUrl, { method: "HEAD", signal: request.signal }));
  if (!pin) return error(404, "resource_not_found");
  if (!pin.ok) return pin;
  const releaseId = pin.headers.get("x-haneoka-release-id") || "",
    sourceId = pin.headers.get("x-haneoka-source-id") || "";
  if (!/^r-[a-f0-9]{20}$/u.test(releaseId) || !sourceId || (releases[0] && releases[0] !== releaseId))
    return error(502, "release_identity_invalid");
  const read = async (path: string): Promise<unknown> => {
    const target = new URL(prefix + path, url);
    target.searchParams.set("release", releaseId);
    const response = await readCatalog(
      new Request(target, { signal: request.signal, headers: { accept: "application/json" } }),
    );
    if (!response?.ok) throw new Error(`team-data-catalog:${path}/${response?.status ?? 404}`);
    if (
      response.headers.get("x-haneoka-release-id") !== releaseId ||
      response.headers.get("x-haneoka-source-id") !== sourceId
    )
      throw new Error("team-data-release-mismatch");
    return response.json();
  };
  try {
    const response = await teamBuilderDataResponse({
      identity: { server, releaseId, sourceId },
      readCollection: read,
      readEntity: (resource, id) => read(`${resource}/${encodeURIComponent(id)}`),
    });
    if (request.method === "HEAD") {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  } catch (errorValue) {
    if (request.signal.aborted) throw errorValue;
    return error(
      502,
      errorValue instanceof Error && errorValue.message === "team-data-release-mismatch"
        ? "release_identity_mismatch"
        : "team_data_unavailable",
    );
  }
}
