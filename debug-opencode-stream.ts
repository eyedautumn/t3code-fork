import { createOpencodeClient } from "@opencode-ai/sdk";

const hostname = "127.0.0.1";
const port = 4096;

async function main() {
  console.log("🔌 Connecting to OpenCode...");

  const client = createOpencodeClient({
    baseUrl: `http://${hostname}:${port}`,
  });

  // ─────────────────────────────────────────────
  // 1. Create session
  // ─────────────────────────────────────────────
  const sessionRes = await client.session.create({
    body: {
      title: "Debug Stream Session",
      model: { providerID: "opencode", modelID: "big-pickle" },
    },
  });

  const sessionId = sessionRes.data?.id;
  if (!sessionId) {
    throw new Error("Failed to create session");
  }

  console.log("✅ Session:", sessionId);

  // ─────────────────────────────────────────────
  // 2. Subscribe FIRST (same as adapter)
  // ─────────────────────────────────────────────
  console.log("📡 Subscribing to SSE stream...");

  const events = await client.event.subscribe();

  // ─────────────────────────────────────────────
  // 3. Start streaming loop (fire-and-forget)
  // ─────────────────────────────────────────────
  const partsState = new Map<string, any>();

const streamLoop = (async () => {
  for await (const evt of events.stream) {
    const { type, properties } = evt;

    if (
      properties?.sessionID &&
      properties.sessionID !== sessionId
    ) continue;

    // ─────────────────────────────────────────────
    // RAW EVENT (for debugging truth)
    // ─────────────────────────────────────────────
    console.log("\n🟡 EVENT:", type);

    switch (type) {
      case "message.part.updated": {
        const part = properties.part;
        const partId = part?.id ?? "unknown";

        // store full state
        partsState.set(partId, part);

        // extract delta safely
        let delta =
          typeof properties.delta === "string"
            ? properties.delta
            : properties?.delta?.text ?? "";

        // detect part type
        const partType = part?.type || "unknown";

        // ─────────────────────────────────────────────
        // 🧠 THINKING / REASONING STREAM
        // ─────────────────────────────────────────────
        if (partType === "reasoning" || partType === "thinking") {
          if (delta) {
            process.stdout.write(`\n🧠 ${delta}`);
          }

          console.log("\n🧠 FULL REASONING PART:");
          console.dir(part, { depth: 5 });

          break;
        }

        // ─────────────────────────────────────────────
        // 💬 TEXT STREAM
        // ─────────────────────────────────────────────
        if (partType === "text") {
          if (delta) {
            process.stdout.write(delta);
          }

          console.log("\n📦 FULL TEXT PART STATE:");
          console.dir(part, { depth: 5 });

          break;
        }

        // ─────────────────────────────────────────────
        // 🧩 OTHER PART TYPES (tools, etc.)
        // ─────────────────────────────────────────────
        console.log("\n🧩 OTHER PART:");
        console.dir(part, { depth: 5 });

        break;
      }

      case "message.updated": {
        console.log("\n\n✅ MESSAGE COMPLETED");

        console.log("\n📚 FINAL PARTS SNAPSHOT:");
        for (const [id, part] of partsState.entries()) {
          console.log(`\n--- PART ${id} ---`);
          console.dir(part, { depth: 5 });
        }

        break;
      }

      case "session.idle": {
        console.log("\n🏁 SESSION IDLE (STREAM FINISHED)");
        break;
      }

      case "session.error": {
        console.error("\n❌ ERROR:", properties);
        break;
      }

      default: {
        console.log("🔹 other event:", type);
      }
    }

    if (type === "session.idle") {
      break;
    }
  }
})();

  // ─────────────────────────────────────────────
  // 4. Send prompt (NON BLOCKING)
  // ─────────────────────────────────────────────
  console.log("💬 Sending prompt...");

  await client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: "Explain streaming in one sentence." }],
    },
  });

  // ─────────────────────────────────────────────
  // 5. Wait for stream to finish
  // ─────────────────────────────────────────────
  await streamLoop;

  console.log("\n🎉 Done");

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
