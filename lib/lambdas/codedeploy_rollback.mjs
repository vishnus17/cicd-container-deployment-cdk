import { CodeDeployClient, StopDeploymentCommand } from "@aws-sdk/client-codedeploy"; // ES Modules import
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers"; // ES6 import
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm"; // ES Modules import


export const handler = async (event) => {
  const accountId = process.env.WORKLOAD_ACCOUNT_ID;
  const appName = process.env.APP_NAME;
  const config = { 
    region: 'ca-central-1',
    credentials: fromTemporaryCredentials({
      params: {
        RoleArn: `arn:aws:iam::${accountId}:role/iam-${appName}Codedeploy-rollback-role`,
        RoleSessionName: "CodeDeployAssumedLambdaRole",
      },
    }),
  };

  // Get Deployment ID from SSM Parameter Store
  const ssmClient = new SSMClient(config);
  const ssmInput = { 
    Name: `/${appName}/DeploymentId`,
    WithDecryption: false,
  };
  const ssmCommand = new GetParameterCommand(ssmInput);
  const ssmResponse = await ssmClient.send(ssmCommand);
  console.log("SSM Response:", ssmResponse);
  const deoploymentId = ssmResponse.Parameter.Value;
  console.log("Deployment ID:", deoploymentId);

  const client = new CodeDeployClient(config);

  const input = {
    deploymentId: deoploymentId,
    autoRollbackEnabled: true,
  };
  
  try {
      const command = new StopDeploymentCommand(input);
      const response = await client.send(command);
      console.log("CodeDeploy rollback initiated:", response);
      return {
          statusCode: 200,
          body: "CodeDeploy rollback initiated",
      };
  } catch (error) {
      console.error("Error initiating CodeDeploy rollback:", error);
      return {
          statusCode: 500,
          body: "Error initiating CodeDeploy rollback",
      };
  }
};
