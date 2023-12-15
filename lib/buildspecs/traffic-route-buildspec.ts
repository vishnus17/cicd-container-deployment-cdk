export const trafficRouteHelperContent = {
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
        'output="/tmp/assume-role-output.json"',
        'aws sts assume-role --role-arn "${WORKLOAD_ROLE}" --role-session-name codedeploy-helper  > $output',
        "RoleAccessKeyID=$(cat $output | jq -r '.Credentials''.AccessKeyId')",
        "RoleSecretKey=$(cat $output | jq -r '.Credentials''.SecretAccessKey')",
        "RoleSessionToken=$(cat $output | jq -r '.Credentials''.SessionToken')",
        'export AWS_ACCESS_KEY_ID=$RoleAccessKeyID',
        'export AWS_SECRET_ACCESS_KEY=$RoleSecretKey',
        'export AWS_SESSION_TOKEN=$RoleSessionToken',
        'export AWS_REGION=ca-central-1',
        "aws deploy continue-deployment --deployment-id ${CODEDEPLOY_DEPLOYMENT_ID}",
      ]
    },
    post_build: {
      commands: [

      ]
    },
  },
}