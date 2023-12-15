export const ecrBuildSpecContent = {
  version: "0.2",
  phases: {
    pre_build: {
      commands: [
        'env',
      ]
    },
    build: {
      commands: [
        `docker build -t $ECR_URL .`,
        '$(aws ecr get-login --no-include-email)',
        'docker push $ECR_URL'
      ]
    },
    post_build: {
      commands: [
        'echo "In Post-Build Stage"',
        "printf '[{\"name\":\"containerRepo\",\"imageUri\":\"%s\"}]' $ECR_URL > imagedefinitions.json",
        "pwd; ls -al; cat imagedefinitions.json"
      ]
    },
  },
  artifacts: {
    files: [
      'imagedefinitions.json'
    ]
  }
}