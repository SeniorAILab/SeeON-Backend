FROM jenkins/jenkins@sha256:f4f65e6cd1405cd889b7f5ac33f9d5cdc2a099de6b87fe8a3933b9c5d53d1d02
USER root
ARG DEBIAN_SNAPSHOT=20260623T000000Z
ARG JQ_VERSION=1.7.1-6+deb13u2
RUN set -eux; \
  mv /etc/apt/sources.list.d/debian.sources /tmp/debian.sources; \
  printf '%s\n' \
    "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
    "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie-updates main" \
    "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} trixie-security main" \
    > /etc/apt/sources.list.d/jq-snapshot.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends "jq=${JQ_VERSION}"; \
  apt-get clean; \
  rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/jq-snapshot.list; \
  mv /tmp/debian.sources /etc/apt/sources.list.d/debian.sources
RUN groupmod --gid 1001 jenkins && usermod --uid 1001 --gid 1001 jenkins \
  && chown -R jenkins:jenkins /usr/share/jenkins/ref /var/jenkins_home
USER jenkins
COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt
