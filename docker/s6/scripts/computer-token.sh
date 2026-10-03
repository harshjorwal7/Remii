#!/bin/sh
# The secret the API presents to a person's E2B sandbox.
#
# Recast when the computer moved out of this container. It used to be a shared secret between the
# API and a browser service sitting beside it on an unpublished port, which is why it was generated
# rather than required: two processes an operator cannot address separately should not have to invent
# one. That reason is gone and the reason now is not.
#
# This token is what every E2B sandbox receives as its service secret, and `server/src/config.ts`
# REFUSES TO BOOT without it — a E2B deployment that came up with no token would have every
# sandbox unreachable and no explanation. Generating it here rather than demanding it from the
# operator keeps that from being a configuration trap on a container that is meant to just work.
#
# Still generated rather than required, because a secret invented by an operator and pasted into a
# compose file is a secret in git history, and this one only has to be unguessable from outside.
# Set COMPUTER_TOKEN yourself and this leaves it alone.
set -eu
if [ -z "${COMPUTER_TOKEN:-}" ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' \
    > /run/s6/container_environment/COMPUTER_TOKEN
fi

chmod 0700 /run/s6/container_environment
