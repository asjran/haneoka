import type { APIRoute, GetStaticPaths } from "astro";
import { catalogEntityPayloads, staticResourceServers } from "../../../../../../lib/entity-graph";

/**
 * Build-time entity payloads: one content-addressed JSON document per catalog
 * entity, shared by its five locale pages. See lib/entity-graph.ts.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const output = [];
  for (const server of staticResourceServers()) {
    for (const payload of (await catalogEntityPayloads(server)).values()) {
      output.push({
        params: { server, resource: payload.resource, file: payload.file },
        props: { body: payload.body },
      });
    }
  }
  return output;
};

export const GET: APIRoute = ({ props }) =>
  new Response((props as { body: string }).body, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
