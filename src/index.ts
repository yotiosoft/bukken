import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ScrapeListingSchemaShape } from "./types/schema.js";
import { scrapeListing } from "./services/listingService.js";

const DEFAULT_HOST = process.env.HOST ?? "0.0.0.0";
const DEFAULT_PORT = Number(process.env.PORT ?? "3000");
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, Session>();

const createMcpServer = () => {
  const server = new McpServer({
    name: "BukkenScraperServer",
    version: "0.1.0",
  });

  server.tool(
    "scrape_listing",
    "SUUMO または HOME'S の物件情報をスクレイピングして返します。",
    ScrapeListingSchemaShape,
    scrapeListing
  );

  return server;
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendJsonRpcError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string
) => {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
};

const sendText = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};

const getSessionId = (req: IncomingMessage) => {
  const sessionIdHeader = req.headers["mcp-session-id"];
  if (Array.isArray(sessionIdHeader)) {
    return sessionIdHeader[0];
  }
  return sessionIdHeader;
};

const closeSession = async (sessionId: string) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  sessions.delete(sessionId);
  await session.server.close();
};

const createSession = async () => {
  const server = createMcpServer();
  let session: Session | undefined;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      if (session) {
        sessions.set(sessionId, session);
      }
    },
    onsessionclosed: async (sessionId) => {
      if (sessionId) {
        await closeSession(sessionId);
      }
    },
  });

  session = { server, transport };
  await server.connect(transport as unknown as Transport);
  return session;
};

const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "POST") {
    const body = await readJsonBody(req);
    const sessionId = getSessionId(req);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, 404, -32000, "Session not found");
        return;
      }

      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      sendJsonRpcError(
        res,
        400,
        -32000,
        "Initialization request requires a new session"
      );
      return;
    }

    const session = await createSession();
    await session.transport.handleRequest(req, res, body);
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    const sessionId = getSessionId(req);
    if (!sessionId) {
      sendJsonRpcError(res, 400, -32000, "Missing mcp-session-id header");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      sendJsonRpcError(res, 404, -32000, "Session not found");
      return;
    }

    await session.transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { Allow: "GET, POST, DELETE" });
  res.end();
};

export const main = async () => {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (requestUrl.pathname === "/health") {
        sendJson(res, 200, {
          status: "ok",
          sessions: sessions.size,
        });
        return;
      }

      if (requestUrl.pathname !== MCP_PATH) {
        sendText(res, 404, "Not Found");
        return;
      }

      await handleMcpRequest(req, res);
    } catch (error) {
      console.error("Error while handling request:", error);

      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    }
  });

  httpServer.on("clientError", (error: Error, socket) => {
    console.error("Client error:", error);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  const shutdown = async () => {
    console.error("Shutting down MCP server...");

    httpServer.close();
    await Promise.all([...sessions.keys()].map((sessionId) => closeSession(sessionId)));
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.error(`MCP Server listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}${MCP_PATH}`);
  console.error(`Health check available at http://${DEFAULT_HOST}:${DEFAULT_PORT}/health`);
};

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
