module.exports = {
  apps: [
    {
      name: "instgbot",
      script: "./start.sh",
      interpreter: "/bin/bash",
      cwd: "/root/instgbot",
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
