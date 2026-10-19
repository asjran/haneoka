/** Identity of the static publication serving this HTML, including legacy build.json files. */
export function publishedWebBuildId(value: { id?: unknown; web?: unknown }): string {
  const id = value.web ?? value.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(id))
    throw new Error("Invalid static publication Web identity");
  return id;
}

export const WEB_BUILD_ATTRIBUTE = "data-web-build-id";
