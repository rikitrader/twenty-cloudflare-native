#!/bin/sh
# Start the backup agent, then hand PID 1 to the upstream image entrypoint.
node /cf/agent.js &
cd /app/packages/twenty-server
exec /app/entrypoint.sh node dist/main
