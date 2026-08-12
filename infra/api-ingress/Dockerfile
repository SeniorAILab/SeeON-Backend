FROM nginx:1.27-alpine

COPY infra/api-ingress/nginx.conf /etc/nginx/conf.d/default.conf

ARG DEPLOY_SHA
RUN if [ "${#DEPLOY_SHA}" -ne 40 ] || case "$DEPLOY_SHA" in *[!0123456789abcdef]*) true ;; *) false ;; esac; then \
      printf '%s\n' 'DEPLOY_SHA must be exactly 40 lowercase hexadecimal characters' >&2; \
      exit 1; \
    fi
LABEL org.opencontainers.image.revision="${DEPLOY_SHA}" \
      org.opencontainers.image.source="SeniorAILab/SeeON"

EXPOSE 3000
