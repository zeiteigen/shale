#!/usr/bin/env bun
import { Command } from "commander";
import { Database } from "bun:sqlite";
import { ensureGraphSchema } from "../lib/graph/schema";
import { configureDatabaseConnection } from "../lib/database-connection";
import { createExtensionSDK } from "../sdk";
import { startMcpServer } from "./index";

const program = new Command();

program
  .name("shale-mcp")
  .description("Shale Knowledge Graph MCP (Model Context Protocol) HTTP Server")
  .option(
    "-p, --port <number>",
    "Port to listen on",
    process.env.SHALE_MCP_PORT || process.env.MCP_PORT || "7426",
  )
  .option("-h, --host <string>", "Host to bind on", "127.0.0.1")
  .option("-n, --namespace <string>", "Default graph namespace", "knowledge")
  .option("--db <string>", "Custom database path")
  .action(async (opts) => {
    const port = Number(opts.port);
    const host = opts.host;
    const namespace = opts.namespace;

    let database: Database | undefined;
    if (opts.db) {
      database = new Database(opts.db);
      configureDatabaseConnection(database);
      ensureGraphSchema(database);
    }

    const sdk = createExtensionSDK("mcp-server", {
      namespace,
      ...(database ? { database } : {}),
    });

    const running = await startMcpServer({
      port,
      host,
      namespace,
      sdk,
    });

    console.log(`[Shale MCP] Knowledge Graph MCP Server listening on ${running.url}`);
    console.log(`[Shale MCP] Endpoints:`);
    console.log(`  - Streamable HTTP: ${running.url}/mcp`);
    console.log(`  - SSE Stream:      ${running.url}/sse`);
    console.log(`  - SSE Messages:    ${running.url}/messages`);
    console.log(`  - Health Check:    ${running.url}/health`);

    const shutdown = async () => {
      console.log("\n[Shale MCP] Shutting down...");
      await running.close();
      if (database) database.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse(process.argv);
