const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const SITE_ROOT = path.join(__dirname, "ai-script-detector", "docs");
const ROUTE_ALIASES = new Map([
  ["/design-system", "design-system.html"],
  ["/privacy", "privacy.html"],
  ["/privacy-policy", "privacy.html"],
  ["/support", "support.html"]
]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

const server = http.createServer((request, response) => {
  const method = request.method || "GET";

  if (method !== "GET" && method !== "HEAD") {
    respondText(response, 405, "Method Not Allowed");
    return;
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/healthz") {
    respondJson(response, 200, { ok: true, service: "scriptlens-public-site" }, method);
    return;
  }

  const filePath = resolveRequestPath(url.pathname);
  if (!filePath) {
    respondText(response, 400, "Bad Request");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      const notFoundPath = path.join(SITE_ROOT, "index.html");
      fs.readFile(notFoundPath, (readError, contents) => {
        if (readError) {
          respondText(response, 404, "Not Found");
          return;
        }
        respondBuffer(response, 200, contents, CONTENT_TYPES[".html"], method);
      });
      return;
    }

    fs.readFile(filePath, (readError, contents) => {
      if (readError) {
        respondText(response, 500, "Internal Server Error");
        return;
      }

      const extension = path.extname(filePath).toLowerCase();
      const contentType = CONTENT_TYPES[extension] || "application/octet-stream";
      respondBuffer(response, 200, contents, contentType, method);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ScriptLens public site listening on ${HOST}:${PORT}`);
});

function resolveRequestPath(requestPathname) {
  const normalizedPath = decodeURIComponent(requestPathname || "/");
  const trimmedPath = normalizedPath === "/" ? "/" : normalizedPath.replace(/\/+$/, "");
  const aliasPath = ROUTE_ALIASES.get(trimmedPath) || ROUTE_ALIASES.get(normalizedPath);
  const relativePath = aliasPath || (trimmedPath === "/" ? "index.html" : trimmedPath.replace(/^\/+/, ""));
  const candidatePath = path.resolve(SITE_ROOT, relativePath);

  if (!candidatePath.startsWith(path.resolve(SITE_ROOT))) {
    return "";
  }

  if (path.extname(candidatePath)) {
    return candidatePath;
  }

  return path.join(candidatePath, "index.html");
}

function respondJson(response, statusCode, payload, method) {
  respondBuffer(
    response,
    statusCode,
    Buffer.from(JSON.stringify(payload)),
    "application/json; charset=utf-8",
    method
  );
}

function respondText(response, statusCode, value) {
  respondBuffer(response, statusCode, Buffer.from(String(value)), "text/plain; charset=utf-8", "GET");
}

function respondBuffer(response, statusCode, buffer, contentType, method) {
  const cacheControl =
    contentType.startsWith("text/html") ||
    contentType.startsWith("text/css") ||
    contentType.startsWith("application/javascript")
      ? "no-cache"
      : "public, max-age=3600";

  response.writeHead(statusCode, {
    "Cache-Control": cacheControl,
    "Content-Length": buffer.byteLength,
    "Content-Type": contentType
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(buffer);
}
