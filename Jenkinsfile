pipeline {
  agent {
    node {
      label 'built-in'
      customWorkspace '/opt/eldercare-fall-ai/repo'
    }
  }

  triggers {
    GenericTrigger(
      genericVariables: [
        [key: 'SHA', value: '$.workflow_run.head_sha', expressionType: 'JSONPath'],
        [key: 'REF', value: '$.ref', expressionType: 'JSONPath']
      ],
      tokenCredentialId: 'eldercare-webhook-token',
      printContributedVariables: false,
      printPostContent: false,
      regexpFilterText: '$REF',
      regexpFilterExpression: '^refs/heads/main$'
    )
  }

  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
  }

  parameters {
    string(name: 'SHA', defaultValue: '', description: 'GitHub webhook commit SHA')
    string(name: 'REF', defaultValue: '', description: 'GitHub webhook ref')
  }

  environment {
    DOCKER_BUILDKIT = '1'
    NODE_OPTIONS = '--max-old-space-size=1536'
    BUILDX_BUILDER = 'eldercare-local'
  }

  stages {
    stage('Validate event') {
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          case "$SHA" in
            [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
            *) echo 'SHA must be exactly 40 lowercase hexadecimal characters.' >&2; exit 1 ;;
          esac
          [ "$REF" = 'refs/heads/main' ] || { echo 'REF must be refs/heads/main.' >&2; exit 1; }
        '''
      }
    }

    stage('Fetch exact main') {
      steps {
        sshagent(credentials: ['eldercare-github-deploy-key']) {
          sh '''#!/usr/bin/env sh
            set -eu
            repository='git@github.com:SeniorAILab/eldercare-fall-ai.git'
            if [ ! -d .git ]; then git init; fi
            remotes=$(git remote) || { echo 'Unable to list Git remotes.' >&2; exit 1; }
            if printf '%s\n' "$remotes" | grep -Fx 'origin' >/dev/null; then
              git remote set-url origin "$repository"
            else
              git remote add origin "$repository"
            fi
            git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
            origin_sha=$(git rev-parse refs/remotes/origin/main)
            if [ "$origin_sha" != "$SHA" ]; then
              echo "Discarding stale event for $SHA; origin/main is $origin_sha." >&2
              exit 1
            fi
            git checkout --detach --force "$SHA"
            git clean -ffdqx
          '''
        }
      }
    }
    stage('Preflight resources') {
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          sh scripts/deploy/iwinv-deploy.sh --preflight-only
        '''
      }
    }

    stage('Configure Buildx') {
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          config="$WORKSPACE/.buildkitd.toml"
          printf '%s\n' '[worker.oci]' '  max-parallelism = 1' > "$config"
          if ! builders=$(docker buildx ls 2>&1); then
            printf '%s\n' 'docker buildx ls failed:' >&2
            printf '%s\n' "$builders" >&2
            exit 1
          fi
          if printf '%s\n' "$builders" | awk -v builder="$BUILDX_BUILDER" 'NR > 1 { name=$1; sub(/[*]$/, "", name); if (name == builder) found=1 } END { exit found ? 0 : 1 }'; then
            docker buildx rm "$BUILDX_BUILDER"
          fi
          docker buildx create --name "$BUILDX_BUILDER" --driver docker-container --buildkitd-config "$config" --use
          docker buildx inspect --bootstrap
        '''
      }
    }

    stage('Build backend') {
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          docker buildx build --builder "$BUILDX_BUILDER" --load \
            --build-arg DEPLOY_SHA="$SHA" \
            --build-arg NODE_OPTIONS="$NODE_OPTIONS" \
            --tag "eldercare-backend:$SHA" --file backend/Dockerfile .
        '''
      }
    }

    stage('Build frontend') {
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          docker buildx build --builder "$BUILDX_BUILDER" --load \
            --build-arg DEPLOY_SHA="$SHA" \
            --build-arg NODE_OPTIONS="$NODE_OPTIONS" \
            --tag "eldercare-front:$SHA" --file front/Dockerfile .
        '''
      }
    }

    stage('Deploy') {
      steps {
        lock(resource: 'eldercare-fall-ai-deploy') {
          sh '''#!/usr/bin/env sh
            set -eu
            sh scripts/deploy/iwinv-deploy.sh --sha "$SHA"
          '''
        }
      }
    }
  }

  post {
    failure {
      emailext(
        to: 'admin@example.com',
        subject: "[eldercare-fall-ai] Jenkins deploy failed: ${env.JOB_NAME} #${env.BUILD_NUMBER}",
        body: "Deployment failed for SHA ${params.SHA}. Build: ${env.BUILD_URL}"
      )
    }
  }
}
