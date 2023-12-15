export const ecsBuildSpectContent = {
  version: "0.2",
  phases: {
    pre_build: {
      commands: [
        'env',
        'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
      ]
    },
    build: {
      commands: [
        "ImageUri=$(cat $CODEBUILD_SRC_DIR_Artifact_Source_ECR/imageDetail.json | jq -r '.ImageURI')",
        "echo $ImageUri",
        "sed -i 's|<IMAGE_NAME>|'\"$ImageUri\"'|' taskdef.json",
        'output="/tmp/assume-role-output.json"',
        "aws sts assume-role --role-arn \"${WORKLOAD_ACCT_DEPLOYER_ROLE}\" --role-session-name codedeploy-helper  > $output",
        "RoleAccessKeyID=$(cat $output | jq -r '.Credentials''.AccessKeyId')",
        "RoleSecretKey=$(cat $output | jq -r '.Credentials''.SecretAccessKey')",
        "RoleSessionToken=$(cat $output | jq -r '.Credentials''.SessionToken')",
        "export AWS_ACCESS_KEY_ID=$RoleAccessKeyID",
        "export AWS_SECRET_ACCESS_KEY=$RoleSecretKey",
        "export AWS_SESSION_TOKEN=$RoleSessionToken",
        "export AWS_REGION=ca-central-1",
        "TaskDef=$(aws ecs register-task-definition --cli-input-json file://taskdef.json)",
        "TaskDefArn=$(echo $TaskDef | jq '.taskDefinition''.taskDefinitionArn')",
        "echo $TaskDefArn",
        "sed -i 's|<TASK_DEFINITION>|'\"$TaskDefArn\"'|' appspec.yml"
      ]
    },
    post_build: {
      commands: [

      ]
    },
  },
  artifacts: {
    files: [
      "appspec.yml"
    ]
  }
}