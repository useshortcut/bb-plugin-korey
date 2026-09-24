import { writeFile } from "node:fs/promises";

const SOURCE_URL = "https://api.korey.ai/api/v1/openapi.json";
const API_BASE_URL = "https://api.korey.ai/api/v1";
const API_BASE_PATH = "/api/v1";
const outputUrl = new URL("../korey.openapi.json", import.meta.url);

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(
    `Could not download Korey's OpenAPI document: HTTP ${response.status}`,
  );
}

const document = await response.json();
if (
  typeof document !== "object" ||
  document === null ||
  document.openapi !== "3.1.0" ||
  typeof document.paths !== "object" ||
  document.paths === null ||
  !Array.isArray(document.servers) ||
  !document.servers.some(
    (server) =>
      typeof server === "object" &&
      server !== null &&
      server.url === API_BASE_URL,
  )
) {
  throw new Error("Korey's OpenAPI document has an unexpected shape");
}

const paths = Object.keys(document.paths);
if (
  paths.length === 0 ||
  paths.some((path) => !path.startsWith("/")) ||
  paths.some(
    (path) => path === API_BASE_PATH || path.startsWith(`${API_BASE_PATH}/`),
  )
) {
  throw new Error(
    "Korey's OpenAPI paths must be relative to its /api/v1 server URL",
  );
}

await writeFile(outputUrl, `${JSON.stringify(document, null, 2)}\n`);
