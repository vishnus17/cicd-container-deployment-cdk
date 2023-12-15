import { CodeBuildClient, StartBuildCommand } from "@aws-sdk/client-codebuild"; // ES Modules import

export const handler = async (event, context) => {
  console.log("tag",event.detail.referenceName);
  console.log("ref",event.detail.referenceFullName);

  //Get the repository from the event and show its git clone URL
  var ecr_name = event.detail.referenceName;
  var ecr_url = process.env.ECR_URL + ':' + ecr_name;
  var sourceVersion = event.detail.referenceFullName;
  const client = new CodeBuildClient({ region: "ca-central-1"});
  var params = {
    projectName: process.env.PROJECT_NAME,
    environmentVariablesOverride: [
      {
        name: 'IMAGE_NAME',
        value: ecr_name,
        type: 'PLAINTEXT'
      },
      {
        name: 'ECR_URL',
        value: ecr_url,
        type: 'PLAINTEXT'
      }
    ],
    sourceLocationOverride: process.env.SOURCE_GIT,
    sourceTypeOverride: 'CODECOMMIT',
    sourceVersion: sourceVersion,
  };

  console.log(params);

  if(/rc-/i.test(ecr_name)){
    const codebuildResponse = new StartBuildCommand(params);
    const response = await client.send(codebuildResponse);
    console.log('codebuildResponse: ', response);
  } else{
    console.log("Not a release candidate");
  }
  return {
    statusCode: 200,
    body: JSON.stringify('done'),
  };
};