export const codeDeployHelperContent = {
  version: "0.2",
  env: {
    "variables": {
      "DEPLOYMENT_ID": "NONE"
    },
    "exported-variables": [
      "DEPLOYMENT_ID",
    ]
  },
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
        'aws sts assume-role --role-arn "${WORKLOAD_ACCT_DEPLOYER_ROLE}" --role-session-name codedeploy-helper  > $output',
        "RoleAccessKeyID=$(cat $output | jq -r '.Credentials''.AccessKeyId')",
        "RoleSecretKey=$(cat $output | jq -r '.Credentials''.SecretAccessKey')",
        "RoleSessionToken=$(cat $output | jq -r '.Credentials''.SessionToken')",
        'export AWS_ACCESS_KEY_ID=$RoleAccessKeyID',
        'export AWS_SECRET_ACCESS_KEY=$RoleSecretKey',
        'export AWS_SESSION_TOKEN=$RoleSessionToken',
        'export AWS_REGION=ca-central-1',
        "UnpBucketName=\"$( cut -d '/' -f 1 <<< \"$CODEBUILD_SOURCE_VERSION\" )\"",
        "arns3pattern=\"arn:aws:s3:::\"",
        "BucketName=$(echo $UnpBucketName | sed \"s/$arns3pattern//\")",
        "Key=\"$( cut -d '/' -f 2- <<< \"$CODEBUILD_SOURCE_VERSION\" )\"",
        "echo $BucketName",
        "echo $Key",
        "rm -rf *",
        "aws s3 cp s3://$BucketName/$Key appspec.zip",
        "unzip appspec.zip",
        "unset AWS_ACCESS_KEY_ID",
        "unset AWS_SECRET_ACCESS_KEY",
        "unset AWS_SESSION_TOKEN",
        "aws s3 cp appspec.yml s3://$BucketName/$Key/appspec.yml",
        "new_key=$Key/appspec.yml",
        "export AWS_ACCESS_KEY_ID=$RoleAccessKeyID",
        "export AWS_SECRET_ACCESS_KEY=$RoleSecretKey",
        "export AWS_SESSION_TOKEN=$RoleSessionToken",
        "DEPLOYMENT_ID=$(echo $(aws deploy create-deployment --application-name \"${CODEDEPLOY_APP_NAME}\" --deployment-group-name \"${CODEDEPLOY_GROUP_NAME}\" --s3-location bucket=$BucketName,bundleType=yaml,key=$new_key) | jq -r '.deploymentId')",
        "echo $DEPLOYMENT_ID",
        "aws ssm put-parameter --name /${APP_NAME}/DeploymentId --value $DEPLOYMENT_ID --type String --overwrite",
        "DEPLOYMENT_STATUS=$(echo $(aws deploy get-deployment --deployment-id $DEPLOYMENT_ID) | jq -r '.deploymentInfo''.status')",
        "while [ \"$DEPLOYMENT_STATUS\" != \"Ready\" ]; do DEPLOYMENT_STATUS=$(echo $(aws deploy get-deployment --deployment-id $DEPLOYMENT_ID) | jq -r '.deploymentInfo''.status') && echo \"--- DEPLOYMENT IN PROGRESS ---\" && sleep 10 ; done",
        'echo "******** DEPLOYMENT STATUS $DEPLOYMENT_STATUS ********"'
      ]
    },
    post_build: {
      commands: [
      ]
    },
  },
}