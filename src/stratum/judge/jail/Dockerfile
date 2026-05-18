# STRAT-JUDGE-T3-READJAIL-CODEXNEST — vendored, pinned codex jail image.
#
# Minimal: node + a pinned @openai/codex, non-root. The CONTAINER is the
# read-jail (the caller mounts ONLY the staged turn tree :ro); codex runs
# with --dangerously-bypass-approvals-and-sandbox inside because the
# container is the externally-enforced sandbox. No ENTRYPOINT munging —
# the connector passes the full `codex …` argv explicitly.
#
# Tag is content-addressed (sha256 of this file + the pinned version) by
# sandbox._image_tag(); bump the version below to force a rebuild.
FROM node:22-slim

# node:*-slim ships no root CA bundle → codex's TLS to the model API fails
# with "no native root CA certificates found" (caught by the live gate).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pin must match stratum.judge.sandbox._PINNED_CODEX_VERSION.
ARG CODEX_VERSION=0.130.0
RUN npm install -g @openai/codex@${CODEX_VERSION} \
    && npm cache clean --force

# Non-root: the adversary never needs root inside the jail.
RUN useradd --create-home --shell /usr/sbin/nologin jail
USER jail
WORKDIR /home/jail
