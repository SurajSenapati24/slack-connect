import express from "express";
import axios from "axios";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import { nanoid } from "nanoid";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import schedule from "node-schedule";

dotenv.config();

// ---------------- Types ----------------
interface Token {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  obtained_at: number;
  team_id?: string;
  team_name?: string;
}

type MessageStatus = "scheduled" | "sent" | "canceled" | "failed";

interface ScheduledMessage {
  id: string;
  userId: string; // team id
  channelId: string;
  text: string;
  sendAt: string; // ISO
  status: MessageStatus;
  created_at: number;
  error?: string;
}

type Data = {
  tokens: Record<string, Token>;
  scheduledMessages: ScheduledMessage[];
};

// ---------------- App setup ----------------
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = Number(process.env.PORT || 3000);
const client_id = process.env.SLACK_CLIENT_ID || "";
const client_secret = process.env.SLACK_CLIENT_SECRET || "";
const redirect_uri = process.env.SLACK_REDIRECT_URI || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "changeme";

if (!client_id || !client_secret || !redirect_uri) {
  console.error("❌ Missing SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, or SLACK_REDIRECT_URI in .env");
  process.exit(1);
}

// ---------------- LowDB setup ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbFile = path.join(__dirname, "..", "db.json");

const adapter = new JSONFile<Data>(dbFile);
const defaultData: Data = { tokens: {}, scheduledMessages: [] };
const db = new Low<Data>(adapter, defaultData);

const scheduledJobs = new Map<string, schedule.Job>();

// ---------------- Helpers ----------------
function isTokenExpired(token: Token): boolean {
  if (!token.expires_in) return false;
  const now = Date.now();
  return (now - token.obtained_at) / 1000 >= token.expires_in;
}

async function saveDB() {
  await db.write();
}

async function refreshAccessToken(userId: string): Promise<Token | null> {
  await db.read();
  const token = db.data?.tokens[userId];
  if (!token || !token.refresh_token) return null;

  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id,
      client_secret,
      refresh_token: token.refresh_token,
    });

    const resp = await axios.post("https://slack.com/api/oauth.v2.access", params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (resp.data.ok) {
      const newToken: Token = {
        access_token: resp.data.access_token,
        refresh_token: resp.data.refresh_token || token.refresh_token,
        expires_in: resp.data.expires_in || token.expires_in,
        scope: resp.data.scope || token.scope,
        token_type: resp.data.token_type || token.token_type,
        obtained_at: Date.now(),
        team_id: resp.data.team?.id || token.team_id,
        team_name: resp.data.team?.name || token.team_name,
      };
      db.data!.tokens[userId] = newToken;
      await saveDB();
      console.log("✅ Refreshed token for", userId);
      return newToken;
    } else {
      console.error("❌ Failed to refresh:", resp.data);
      return null;
    }
  } catch (err) {
    console.error("❌ Refresh error:", err);
    return null;
  }
}

async function getValidAccessToken(userId: string): Promise<string | null> {
  await db.read();
  const token = db.data?.tokens[userId];
  if (!token) return null;

  if (isTokenExpired(token) && token.refresh_token) {
    const newToken = await refreshAccessToken(userId);
    return newToken ? newToken.access_token : null;
  }
  return token.access_token;
}

async function slackRequest(userId: string, method: "get" | "post", url: string, data?: any, params?: any) {
  let token = await getValidAccessToken(userId);
  if (!token) throw new Error("No valid token for userId: " + userId);

  const config: any = {
    headers: { Authorization: `Bearer ${token}` },
    params,
  };

  try {
    if (method === "get") {
      const resp = await axios.get(url, config);
      if (!resp.data.ok) throw new Error(JSON.stringify(resp.data));
      return resp.data;
    } else {
      const resp = await axios.post(url, data, { ...config, headers: { ...config.headers, "Content-Type": "application/json" } });
      if (!resp.data.ok) throw new Error(JSON.stringify(resp.data));
      return resp.data;
    }
  } catch (err) {
    throw err;
  }
}

// ---------------- Scheduling ----------------
async function scheduleSend(smsg: ScheduledMessage) {
  const date = new Date(smsg.sendAt);
  if (date <= new Date()) return;

  const job = schedule.scheduleJob(date, async () => {
    try {
      await slackRequest(smsg.userId, "post", "https://slack.com/api/chat.postMessage", {
        channel: smsg.channelId,
        text: smsg.text,
      });
      await db.read();
      const found = db.data!.scheduledMessages.find((m) => m.id === smsg.id);
      if (found) {
        found.status = "sent";
        found.error = undefined;
        await saveDB();
      }
      scheduledJobs.delete(smsg.id);
    } catch (err: any) {
      console.error("❌ Failed to send scheduled message:", err?.message);
      await db.read();
      const found = db.data!.scheduledMessages.find((m) => m.id === smsg.id);
      if (found) {
        found.status = "failed";
        found.error = err?.message || String(err);
        await saveDB();
      }
    }
  });

  scheduledJobs.set(smsg.id, job);
}

async function reloadSchedules() {
  await db.read();
  const pending = db.data!.scheduledMessages.filter((m) => m.status === "scheduled");
  for (const m of pending) {
    if (new Date(m.sendAt) > new Date()) {
      scheduleSend(m);
    } else {
      m.status = "failed";
      m.error = "Missed scheduled time";
    }
  }
  await saveDB();
}

// ---------------- OAuth ----------------
const stateStore = new Set<string>();

app.get("/auth/slack", (req, res) => {
  const state = nanoid();
  stateStore.add(state);
  const scopes = ["chat:write", "channels:read"];
  const url = `https://slack.com/oauth/v2/authorize?client_id=${client_id}&scope=${encodeURIComponent(
    scopes.join(" ")
  )}&redirect_uri=${encodeURIComponent(redirect_uri)}&state=${state}`;
  res.redirect(url);
});

app.get("/auth/slack/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");

  if (!code) return res.status(400).send("Missing code");
  if (!stateStore.has(state)) return res.status(400).send("Invalid state");
  stateStore.delete(state);

  try {
    const params = new URLSearchParams({
      client_id,
      client_secret,
      code,
      redirect_uri,
    }).toString();

    const response = await axios.post("https://slack.com/api/oauth.v2.access", params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const data = response.data;
    if (!data.ok) {
      console.error("OAuth failure:", data);
      return res.status(400).send("Slack OAuth failed: " + JSON.stringify(data));
    }

    // Bot token
    const botToken = data.access_token; // xoxb-...
    const teamId = data.team?.id || nanoid();
    const teamName = data.team?.name || "unknown";

    const token: Token = {
      access_token: botToken,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      scope: data.scope,
      token_type: data.token_type,
      obtained_at: Date.now(),
      team_id: teamId,
      team_name: teamName,
    };

    await db.read();
    db.data!.tokens[teamId] = token;
    await saveDB();

    res.send(`<h2>Slack connected for team: ${teamName} (${teamId})</h2><p>You can close this window.</p>`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Internal Error");
  }
});

// ---------------- API ----------------
app.get("/channels", async (req, res) => {
  const userId = String(req.query.userId || "");
  if (!userId) return res.status(400).send("Missing userId");

  try {
    const data = await slackRequest(userId, "get", "https://slack.com/api/conversations.list", null, {
      exclude_archived: true,
      limit: 200,
      types: "public_channel,private_channel",
    });
    res.json({ ok: true, channels: data.channels });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.post("/send-message", async (req, res) => {
  const { userId, channelId, text } = req.body;
  if (!userId || !channelId || !text) return res.status(400).send("Missing fields");

  try {
    const result = await slackRequest(userId, "post", "https://slack.com/api/chat.postMessage", {
      channel: channelId,
      text,
    });
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.post("/schedule-message", async (req, res) => {
  const { userId, channelId, text, sendAt } = req.body;
  if (!userId || !channelId || !text || !sendAt) return res.status(400).send("Missing fields");

  const sm: ScheduledMessage = {
    id: nanoid(),
    userId,
    channelId,
    text,
    sendAt,
    status: "scheduled",
    created_at: Date.now(),
  };

  await db.read();
  db.data!.scheduledMessages.push(sm);
  await saveDB();
  scheduleSend(sm);

  res.json({ ok: true, scheduledId: sm.id });
});

app.get("/scheduled-messages", async (req, res) => {
  const userId = String(req.query.userId || "");
  await db.read();
  const list = db.data!.scheduledMessages.filter((m) => m.userId === userId);
  res.json({ ok: true, scheduled: list });
});

app.delete("/scheduled-messages/:id", async (req, res) => {
  const id = req.params.id;
  const userId = String(req.query.userId || "");

  await db.read();
  const msg = db.data!.scheduledMessages.find((m) => m.id === id && m.userId === userId);
  if (!msg) return res.status(404).send("Not found");

  if (msg.status === "scheduled") {
    const job = scheduledJobs.get(id);
    if (job) job.cancel();
    msg.status = "canceled";
    await saveDB();
  }

  res.json({ ok: true });
});

// ---------------- Start ----------------
(async () => {
  await db.read();
  await reloadSchedules();

  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
})();
