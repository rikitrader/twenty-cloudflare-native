#!/bin/sh
# Start the backup agent, then hand PID 1 to the image's original s6 init.
node /cf/agent.js &
exec /init
