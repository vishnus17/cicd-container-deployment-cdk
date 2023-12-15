import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { ecrBuildSpecContent } from "./buildspecs/ecr-buildspec";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from 'path';

export interface containerBuildPipelineStackPros extends StackProps {
  appName: string;
}

export class containerBuildPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: containerBuildPipelineStackPros) {
    super(scope, id, props);

    const regionShort = {
      'ca-central-1': 'cac1',
      'us-east-1': 'ue1',
      'us-east-2': 'ue2',
      'us-west-1': 'uw1',
      'us-west-2': 'uw2',
    }[this.region]

    const appName = props.appName;
    const accountId = this.account;

    /* ECR Docker Image Build Pipeline 
      This will create IAM roles, resource policies, CodeCommit, ECR repository
      CodeBuild project to build the docker container. Once the code is pushed
      to CodeCommit, this pipeline will run to create a docker and push it to ECR.
    */

    /* Create a source code repo in CodeCommit */
    const codeRepo = new codecommit.Repository(this, 'coderepo', {
      repositoryName: `${appName}`,
      description: 'codecommit',
    });



    /* Create ECR and set policies to allow workload account and Ops account
       to pull the images.
    */
    const ecrRepo = new ecr.Repository(this, `${appName}-ecr-repo`, {
      repositoryName: `${appName}`,
      imageScanOnPush: true,
    });

    const ecrPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload"
      ],
      principals: [
        new iam.AccountPrincipal("123123123"), // Enter your Workload Account ID here
      ]
    })
    ecrRepo.addToResourcePolicy(ecrPolicy);


    
    /* Create CodeBuild to build the project and all necessary roles for the CodeBuild */
    const ecsServiceRole = new iam.Role(this, `ecs-${appName}-ServiceRole`, {
      roleName: `role-${appName}-serviceRole`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com')
    });

    const ecsInlinePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole',
        'sts:AssumeRole',
        "codecommit:*",
        'ecr:*'
      ],
      resources: ['*']
    });

    ecsServiceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildDeveloperAccess'))
    ecsServiceRole.addToPolicy(ecsInlinePolicy);

    const project = new codebuild.Project(this, `${appName}-project`, {
      projectName: `codebuild-${appName}-${regionShort}-01`,
      role: ecsServiceRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        privileged: true
      },
      environmentVariables: {
        'ECR_URL': {
          value: `${ecrRepo.repositoryUri}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject(ecrBuildSpecContent)
    });

    ecrRepo.grantPullPush(project.role!) // allow CodeBuild to push built container to ECR


    /* Create Lambda, and Lambda roles to trigger CodeBuild project on a push to CodeCommit */
    const helperLambdaServiceRole = new iam.Role(this, `${appName}-triggerLambda`, {
      roleName: `role-${appName}-triggerLambda`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const helperLambdaInlinePolicyForLambda = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole',
        'sts:AssumeRole',
        'codebuild:Start*',
        'codebuild:List*',
        'codebuild:Update*'
      ],
      resources: ['*']
    });

    helperLambdaServiceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
    helperLambdaServiceRole.addToPolicy(helperLambdaInlinePolicyForLambda);

    const triggerTrafficLambda = new lambda.Function(this, 'triggerBuildLambda', {
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'lambdas'),
        {
          exclude: ['**', '!build_trigger_lambda.mjs']
        }),
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'build_trigger_lambda.handler',
      role: helperLambdaServiceRole,
      description: 'Lambda to trigger ECR build from CodeCommit webhook',
      memorySize: 128,
      timeout: cdk.Duration.seconds(60),
      functionName: `lambda-${appName}TriggerBuild-${regionShort}-01`,
      environment: {
        PROJECT_NAME: project.projectName,
        ECR_URL: ecrRepo.repositoryUri,
        SOURCE_GIT: codeRepo.repositoryCloneUrlHttp
      }
    });

    // give CodeCommit access to trigger Lambda
    const codeCommitPrincipal = new iam.ServicePrincipal('codecommit.amazonaws.com');
    triggerTrafficLambda.grantInvoke(codeCommitPrincipal)

    codeRepo.onCommit('onCommit', {
      target: new targets.LambdaFunction(triggerTrafficLambda),
      eventPattern: {
        source: ['aws.codecommit'],
        detailType: ['CodeCommit Repository State Change'],
        detail: {
          event: [
            'referenceCreated',
            'referenceUpdated'
          ],
        },
        resources: [
          codeRepo.repositoryArn
        ]
      },
      ruleName: `codecommit-${appName}-trigger-${regionShort}-01`
    });
  }
}