FROM debian:bookworm-slim

ARG GH_RUNNER_VERSION=2.328.0
ENV RUNNER_HOME=/runner \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl ca-certificates git jq bash coreutils libicu72 unzip tar \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -d ${RUNNER_HOME} -s /bin/bash runner && \
    mkdir -p ${RUNNER_HOME}/_work ${RUNNER_HOME}/bin && \
    chown -R runner:runner ${RUNNER_HOME}

WORKDIR ${RUNNER_HOME}

RUN ARCH="$(uname -m)"; \
    case "$ARCH" in \
      x86_64)   RUNNER_ARCH=x64 ;; \
      aarch64)  RUNNER_ARCH=arm64 ;; \
      armv7l)   RUNNER_ARCH=arm ;; \
      *)        echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac; \
    curl -fsSL -o actions-runner.tar.gz \
      https://github.com/actions/runner/releases/download/v${GH_RUNNER_VERSION}/actions-runner-linux-${RUNNER_ARCH}-${GH_RUNNER_VERSION}.tar.gz && \
    tar xzf actions-runner.tar.gz && rm actions-runner.tar.gz && \
    ./bin/installdependencies.sh

# Copy entrypoint
COPY --chown=runner:runner entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER runner
ENV PATH="${RUNNER_HOME}/bin:${PATH}" \
    RUNNER_WORKDIR="${RUNNER_HOME}/_work" \
    RUNNER_NAME="k8s-runner" \
    RUNNER_LABELS="self-hosted,k8s" \
    RUNNER_EPHEMERAL="false"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]