// PM2 config for the production server. CommonJS because the package is "type": "module".
// One instance only: the voice and support WebSockets keep state in memory, and the
// scheduled jobs (@nestjs/schedule) must not run twice.
module.exports = {
  apps: [
    {
      name: 'qimam-api',
      cwd: __dirname + '/..',
      script: 'dist/main.js',
      node_args: '--enable-source-maps',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '700M',
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
