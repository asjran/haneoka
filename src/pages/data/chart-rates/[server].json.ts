import type { APIRoute, GetStaticPaths } from "astro";
import { staticBuildPaths } from "../../../server/static-build";
import { staticCatalogPageServers } from "../../../lib/entity-graph";
import { isReleaseServer } from "../../../lib/release-server";
import { writeStaticJsonDocument } from "../../../server/static-documents";
import { chartRates } from "../../../server/chart-rates";

/** The same complete chart weights consumed by song pages, without locale-specific HTML. */
export const getStaticPaths: GetStaticPaths = async () =>
  staticBuildPaths(
    "src/pages/data/chart-rates/[server].json.ts",
    (await staticCatalogPageServers()).map((server) => ({ params: { server } })),
  );

export const GET: APIRoute = async ({ params }) => {
  const { server } = params;
  if (!isReleaseServer(server)) return new Response("Not found", { status: 404 });
  const rates = await chartRates(server);
  writeStaticJsonDocument(`/data/chart-rates/${server}.json`, rates);
  return new Response(JSON.stringify(rates), {
    headers: {
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "content-type": "application/json; charset=utf-8",
    },
  });
};
