pipeline {
  agent {
    node {
      label 'built-in'
      customWorkspace '/opt/eldercare-fall-ai/repo'
    }
  }

  triggers {
    GenericTrigger(
      tokenCredentialId: 'eldercare-webhook-token',
      printContributedVariables: false,
      printPostContent: false
    )
  }

  options {
    disableConcurrentBuilds()
    skipDefaultCheckout(true)
  }

  environment {
    DOCKER_BUILDKIT = '1'
    NODE_OPTIONS = '--max-old-space-size=1536'
    BUILDX_BUILDER = 'eldercare-local'
    DEPLOY_ROOT = '/opt/eldercare-fall-ai'
  }

  stages {
    stage('Resolve release') {
      steps {
        script {
          def resolverOutput = sshagent(credentials: ['eldercare-github-deploy-key']) {
            sh(
              script: '''#!/usr/bin/env sh
                set -eu
                repository='git@github.com:SeniorAILab/eldercare-fall-ai.git'
                if [ ! -d .git ]; then git init 1>&2; fi
                remotes=$(git remote) || { echo 'Unable to list Git remotes.' >&2; exit 1; }
                if printf '%s\n' "$remotes" | grep -Fx 'origin' >/dev/null; then
                  git remote set-url origin "$repository"
                else
                  git remote add origin "$repository"
                fi
                git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
                trap 'rm -f "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"' EXIT HUP INT TERM
                git show refs/remotes/origin/main:scripts/deploy/iwinv-resolve-release.sh > "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"
                RELEASES_DIR="$DEPLOY_ROOT/releases" sh "$WORKSPACE/.iwinv-resolve-release.jenkins.sh"
              ''',
              returnStdout: true
            ).trim()
          }
          def releaseValues = [:]
          resolverOutput.readLines().each { line ->
            if (line.trim().isEmpty()) {
              return
            }
            def match = line =~ /^(RELEASE_TAG|RELEASE_SHA|NO_OP)=(.*)$/
            if (!match.matches()) {
              error("Unexpected resolver output line: ${line}")
            }
            def key = match[0][1]
            if (releaseValues.containsKey(key)) {
              error("Resolver output contains duplicate ${key}")
            }
            releaseValues[key] = match[0][2]
          }
          ['RELEASE_TAG', 'RELEASE_SHA', 'NO_OP'].each { key ->
            if (!releaseValues.containsKey(key)) {
              error("Resolver output is missing ${key}")
            }
          }
          if (!(releaseValues.RELEASE_TAG ==~ /v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/)) {
            error("Resolver output has invalid RELEASE_TAG: ${releaseValues.RELEASE_TAG}")
          }
          if (!(releaseValues.RELEASE_SHA ==~ /[0-9a-f]{40}/)) {
            error("Resolver output has invalid RELEASE_SHA: ${releaseValues.RELEASE_SHA}")
          }
          if (!['0', '1'].contains(releaseValues.NO_OP)) {
            error("Resolver output has invalid NO_OP: ${releaseValues.NO_OP}")
          }
          env.RELEASE_TAG = releaseValues.RELEASE_TAG
          env.RELEASE_SHA = releaseValues.RELEASE_SHA
          env.NO_OP = releaseValues.NO_OP
          if (env.NO_OP != '1') {
            sh '''#!/usr/bin/env sh
              set -eu
              git checkout --detach --force "$RELEASE_SHA"
              git clean -ffdqx
            '''
          }
        }
      }
    }
    stage('Preflight resources') {
      when {
        expression { env.NO_OP != '1' }
      }
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          sh scripts/deploy/iwinv-deploy.sh --preflight-only
        '''
      }
    }

    stage('Configure Buildx') {
      when {
        expression { env.NO_OP != '1' }
      }
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
      when {
        expression { env.NO_OP != '1' }
      }
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          docker buildx build --builder "$BUILDX_BUILDER" --load \
            --build-arg DEPLOY_SHA="$RELEASE_SHA" \
            --build-arg NODE_OPTIONS="$NODE_OPTIONS" \
            --tag "eldercare-backend:$RELEASE_SHA" --file backend/Dockerfile .
        '''
      }
    }

    stage('Build frontend') {
      when {
        expression { env.NO_OP != '1' }
      }
      steps {
        sh '''#!/usr/bin/env sh
          set -eu
          docker buildx build --builder "$BUILDX_BUILDER" --load \
            --build-arg DEPLOY_SHA="$RELEASE_SHA" \
            --build-arg NODE_OPTIONS="$NODE_OPTIONS" \
            --tag "eldercare-front:$RELEASE_SHA" --file front/Dockerfile .
        '''
      }
    }

    stage('Deploy') {
      when {
        expression { env.NO_OP != '1' }
      }
      steps {
        lock(resource: 'eldercare-fall-ai-deploy') {
          sh '''#!/usr/bin/env sh
            set -eu
            sh scripts/deploy/iwinv-deploy.sh --sha "$RELEASE_SHA"
          '''
        }
      }
    }
  }

  post {
    failure {
      emailext(
        to: 'admin@example.com',
        subject: "[eldercare-fall-ai] Jenkins deploy failed: ${env.RELEASE_SHA ?: 'unresolved'}",
        body: "Deployment failed for release SHA ${env.RELEASE_SHA ?: 'unresolved'}. Build: ${env.BUILD_URL}"
      )
    }
  }
}
