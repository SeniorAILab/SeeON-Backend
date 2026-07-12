pipelineJob('eldercare-fall-ai-cd') {
  description('Deploy front and backend to iwinv when a production GitHub release is published. The empty webhook signal wakes Jenkins; the pipeline resolves the highest stable vX.Y.Z tag itself.')
  triggers {
    genericTrigger {
      causeString('Production release published on GitHub')
      tokenCredentialId('eldercare-webhook-token')
      printContributedVariables(false)
      printPostContent(false)
      silentResponse(false)
      shouldNotFlatten(false)
    }
  }
  properties {
    disableConcurrentBuilds()
  }
  definition {
    cpsScm {
      scm {
        git {
          remote {
            url('git@github.com:SeniorAILab/eldercare-fall-ai.git')
            credentials('eldercare-github-deploy-key')
          }
          branch('*/main')
          extensions {
            cloneOptions {
              shallow(false)
              noTags(false)
              honorRefspec(true)
            }
          }
        }
      }
      scriptPath('Jenkinsfile')
      lightweight(false)
    }
  }
  logRotator {
    numToKeep(30)
  }
}
