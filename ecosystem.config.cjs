// pm2 process definition for sf-copilot-proxy.
// Usage: pm2 start ecosystem.config.cjs   (run from this directory)
const { join } = require("node:path");

module.exports = {
  apps: [
    {
      name: "sf-copilot-proxy",
      script: "src/server.ts",
      // Run the .ts entry directly via Node's native type stripping.
      interpreter: "node",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Back off if it crash-loops; don't hammer restarts.
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      // Config comes from .env (loaded by src/config.ts), not from here.
      out_file: join(__dirname, "logs", "out.log"),
      error_file: join(__dirname, "logs", "error.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
