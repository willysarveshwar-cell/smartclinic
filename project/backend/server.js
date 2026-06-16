const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
require("dotenv").config();

const db = require("./db");
const { processScheduledNotifications } = require("./services/notificationService");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/admin", require("./routes/admin"));
app.use("/api/doctors", require("./routes/doctors"));
app.use("/api/appointments", require("./routes/appointments"));
app.use("/api/queue", require("./routes/queue"));
app.use("/api/patients", require("./routes/patients"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/chat", require("./routes/chat"));
app.use("/api/leaves", require("./routes/leaves"));

// Serve frontend static files
app.use(express.static(path.join(__dirname, "../frontend")));

// Health check (API only)
app.get("/api", (req, res) => {
  res.send("Smart Clinic Backend is running");
});

// DB diagnostic endpoint
app.get("/api/health", async (req, res) => {
  const dbUrl = process.env.SUPABASE_DB_URL;
  try {
    const [check] = await db.queryAsync("SELECT 1 AS ok");
    const doctors = await db.queryAsync("SELECT COUNT(*) AS cnt FROM doctors");
    const doctorCount = doctors[0] ? (doctors[0].cnt || doctors[0].count || 0) : 0;
    res.json({ ok: true, db: dbUrl ? "supabase-url-set" : "no-url", doctorCount, usesRealPool: db.usesRealPool() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({ message: "Internal server error" });
});

if (require.main === module) {
  // Local development: start HTTP server with Socket.io
  const { Server } = require("socket.io");
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE"]
    }
  });

  app.set("io", io);

  io.on("connection", (socket) => {
    socket.emit("connected", { message: "Realtime channel connected" });
  });

  const PORT = process.env.PORT || 5000;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Stop the other server or set PORT to a different value.`
      );
    } else {
      console.error("Server error:", err);
    }
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });

  setInterval(async () => {
    try {
      const summary = await processScheduledNotifications(db);
      if (summary.remindersSent || summary.missedSent) {
        console.log("[Notifications] Scheduled jobs processed", summary);
      }
    } catch (error) {
      console.error("[Notifications] Scheduled job error:", error.message);
    }
  }, 60 * 1000);
} else {
  // Serverless (Vercel): provide a no-op io so routes that call io.emit don't crash
  app.set("io", {
    emit: () => {},
    to: () => ({ emit: () => {} }),
    in: () => ({ emit: () => {} })
  });
}

module.exports = app;
