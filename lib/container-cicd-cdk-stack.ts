import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import { MultiAccountECS } from './multi-account-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { ecsBuildSpecContent } from "./buildspecs/ecs-buildspec";
import { codeDeployHelperContent } from "./buildspecs/codedeploy-helper-buildspec";
import { trafficRouteHelperContent } from "./buildspecs/traffic-route-buildspec";
import * as path from 'path';
export interface containerCICDCdkStackPros extends StackProps {
  accountId: string;
  appName: string;
  stageName: string;
  vpcId: string;
  privateSub1: string;
  privateSub2: string;
  privateSub3: string;
  pubSub1: string;
  pubSub2: string;
  pubSub3: string;
  opsAccountId: string;
}

export class containerCICDCdkStack extends Stack {
  constructor(scope: Construct, id: string, props: containerCICDCdkStackPros) {
    super(scope, id, props);

    // region to region short code mapping
    const regionShort = {
      'ca-central-1': 'cac1',
      'us-east-1': 'ue1',
      'us-east-2': 'ue2',
      'us-west-1': 'uw1',
      'us-west-2': 'uw2',
      'ap-south-1': 'aps1'
    }[this.region]

    const appName = props.appName;
    const stageName = props.stageName;
    const accountId = props.accountId;
    const vpcId = props.vpcId;
    const privateSub1 = props.privateSub1;
    const privateSub2 = props.privateSub2;
    const privateSub3 = props.privateSub3;
    const pubSub1 = props.pubSub1;
    const pubSub2 = props.pubSub2;
    const pubSub3 = props.pubSub3;
    const opsAccountId = props.opsAccountId;

    // get an instance of previously deployed ECS stack
    const multiEcs = new MultiAccountECS(
      this,
      'ecsStack',
      {
        stageName: stageName,
        vpcId: vpcId,
        privateSub1: privateSub1,
        privateSub2: privateSub2,
        privateSub3: privateSub3,
        pubSub1: pubSub1,
        pubSub2: pubSub2,
        pubSub3: pubSub3,
        appName: appName,
        env: {
          region: 'ap-south-1',
          account: accountId
        }
      }
    );


    /* Cross-Account Artifacts
      This will create S3 bucket to store the artifacts by the ECS deployment pipeline.
      For any cross-account S3 buckets, CMK is required. It will also create the KMS and
      set resource policies and IAM roles to be used by the ECS deployment
    */

    const prodAccountRootPrincipal = new iam.AccountPrincipal(opsAccountId);

    const key = new kms.Key(this, 'ArtifactKey', {
      alias: `key/${appName}-${stageName}-artifact-key`
    });

    key.grantDecrypt(prodAccountRootPrincipal);
    key.addToResourcePolicy(
      new PolicyStatement(
        {
          principals: [
            new iam.AccountPrincipal(accountId),
            new iam.AccountPrincipal(opsAccountId)
          ],
          actions: [
            "kms:DescribeKey",
            "kms:GenerateDataKey*",
            "kms:Encrypt",
            "kms:ReEncrypt*",
            "kms:Decrypt"
          ],
          resources: ['*']
        }
      )
    );


    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `s3-${appName}deployartifacts-${stageName}-${regionShort}-01`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key
    });

    artifactBucket.grantPut(prodAccountRootPrincipal);
    artifactBucket.grantRead(prodAccountRootPrincipal);
    artifactBucket.addToResourcePolicy(
      new PolicyStatement({
        resources: [
          `${artifactBucket.bucketArn}`,
          `${artifactBucket.bucketArn}/*`
        ],
        actions: [
          "s3:Get*",
          "s3:Put*",
          "s3:ListBucket"
        ],
        principals: [new iam.AccountPrincipal(accountId)]
      })
    );

    artifactBucket.addToResourcePolicy(
      new PolicyStatement({
        resources: [
          `${artifactBucket.bucketArn}`,
          `${artifactBucket.bucketArn}/*`
        ],
        actions: [
          "s3:Put*",
          "s3:Get*",
          "s3:ListBucket"
        ],
        principals: [new iam.AccountPrincipal(opsAccountId)]
      })
    )




    /* ECS Deployment Pipeline
      This section will create code pipeline actions and the pipeline itself
    */
    const ecsBuildOutput = new codepipeline.Artifact();
    const ecrSourceOutput = new codepipeline.Artifact();
    const ecsSourceOutput = new codepipeline.Artifact();
    
    // ECR Repo
    const ecrRepo = ecr.Repository.fromRepositoryName(this, `${appName}-ecr`, `${appName.toLowerCase()}`);

    const ecsRepo = stageName === 'sbx' ?
      codecommit.Repository.fromRepositoryName(this,'ecsRepo', `${appName}EcsRepo-${stageName}-${regionShort}-01`) :
      new codecommit.Repository(this, `${appName}-${stageName}-ecsrepo`, {
        repositoryName: `${appName}EcsRepo-${stageName}-${regionShort}-01`,
        description: 'codecommit',
      });

    // IAM role for the codebuild below
    const ecsCodeBuildRole = new iam.Role(this, `ecs-${stageName}-ServiceRole`, {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildDeveloperAccess')],
    });

    ecsCodeBuildRole.addToPolicy(new PolicyStatement({
      actions: [
        'iam:PassRole',
        'sts:AssumeRole'
      ],
      resources: ['*']
    }));

    ecsCodeBuildRole.addToPolicy(new PolicyStatement({
      actions: [
        'ecr:*'
      ],
      resources: [ecrRepo.repositoryArn]
    }));

    // Source Actions for CodePipeline
    const ecsStageSourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: "CodeCommit",
      repository: ecsRepo,
      output: ecsSourceOutput,
      trigger: codepipeline_actions.CodeCommitTrigger.NONE
    });

    const ecsECRAction = new codepipeline_actions.EcrSourceAction({
      actionName: "ECR",
      repository: ecrRepo,
      output: ecrSourceOutput
    });

    // ECS task definition build
    const ecsProject = new codebuild.Project(this, `${appName}-${stageName}-ecs-build`, {
      projectName: `codebuild-${appName}EcsBuild-${stageName}-${regionShort}-01`,
      role: ecsCodeBuildRole,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        privileged: true
      },
      environmentVariables: {
        'WORKLOAD_ACCOUNT_DEPLOYER_ROLE': {
          value: `${multiEcs.deployRole.roleArn}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject(ecsBuildSpecContent)
    });

    // ECS task definition build action
    const ecsBuildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: ecsProject,
      input: ecsSourceOutput,
      extraInputs: [ecrSourceOutput],
      outputs: [ecsBuildOutput]
    });

    // CodeDeploy helper role
    const codeDeployHelperServiceRole = new iam.Role(this, `${stageName}-helperCodeDeploy`, {
      roleName: `role-${appName}CodeDeployerLambda-${stageName}`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeBuildDeveloperAccess')],
    });

    codeDeployHelperServiceRole.addToPolicy(new PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole',
        'sts:AssumeRole'
      ],
      resources: ['*']
    }));

    // artifact bucket access policy
    codeDeployHelperServiceRole.addToPolicy(new PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',
      ],
      resources: [
        `${artifactBucket.bucketArn}`,
        `${artifactBucket.bucketArn}/*`
      ]
    }));

    // give service role putobject access to s3
    artifactBucket.grantPut(codeDeployHelperServiceRole);

    // Create a deployment in CodeDeploy
    const codeDeployHelperProject = new codebuild.Project(this, `${appName}-${stageName}-codedeploy-helper`, {
      projectName: `codebuild-${appName}CodeDeployHelper-${stageName}-${regionShort}-01`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        privileged: true
      },
      role: codeDeployHelperServiceRole,
      environmentVariables: {
        'WORKLOAD_ACCOUNT_DEPLOYER_ROLE': {
          value: `${multiEcs.deployRole.roleArn}`
        },
        'CODEDEPLOY_APP_NAME': {
          value: `${multiEcs.codeDeployAppName}`
        },
        'CODEDEPLOY_GROUP_NAME': {
          value: `${multiEcs.codeDeployGroupName}`
        },
        'STAGE_NAME': {
          value: `${stageName}`
        },
        'APP_NAME': {
          value: `${appName}`
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject(codeDeployHelperContent)
    });

    // CodeDeploy action
    const codeDeployHelperAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: codeDeployHelperProject,
      input: ecsBuildOutput,
      outputs: [],
      variablesNamespace: "custompipeline"
    });

    // Manual approval action
    const approvalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: "Approve-Route-Traffic",
    });   

    // traffic re-route codebuild
    const trafficRouteHelperProject = new codebuild.Project(this, `${appName}-${stageName}-traffic-helper`, {
      projectName: `codebuild-${appName}TrafficHelper-${stageName}-${regionShort}-01`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        privileged: true
      },
      role: codeDeployHelperServiceRole,
      environmentVariables: {
        'WORKLOAD_ACCOUNT_DEPLOYER_ROLE': {
          value: `${multiEcs.deployRole.roleArn}`
        },
        'CODEDEPLOY_GROUP_NAME': {
          value: `${multiEcs.codeDeployGroupName}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject(trafficRouteHelperContent)
    });

    // Traffic re-route action
    const trafficRouteHelperAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: trafficRouteHelperProject,
      input: ecsBuildOutput,
      environmentVariables: {
        CODEDEPLOY_DEPLOYMENT_ID: { value: '#{custompipeline.DEPLOYMENT_ID}' }
      }
    });

    const ecsPipeline = new codepipeline.Pipeline(this, `${appName}-${stageName}-ecs-deploy-pipeline`, {
      pipelineName: `codepipeline-${appName}Deploy-${stageName}-${regionShort}-01`,
      artifactBucket: artifactBucket,
      crossAccountKeys: true,
      stages: [
        {
          stageName: 'Source',
          actions: [ecsStageSourceAction, ecsECRAction]
        },
        {
          stageName: 'Build',
          actions: [ecsBuildAction]
        },
        {
          stageName: 'CodeDeploy',
          actions: [codeDeployHelperAction]
        },
        {
          stageName: 'Approval',
          actions: [approvalAction]
        },
        {
          stageName: 'Reroute-Traffic',
          actions: [trafficRouteHelperAction]
        }
      ]
    });

    ecrRepo.grantPullPush(ecsProject.role!);
    ecsProject.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ecs:DescribeCluster",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:*",
      ],
      resources: [`${multiEcs.clusterArn}`]
    }));

    ecsPipeline.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "sts:AssumeRole",
          "ecr:*",
          "ssm:*",
        ],
        resources: ['*']
    }));
    
    // Lambda execution role for CodeDeploy rollback
    const rollbackLambdaRole = new iam.Role(this, `${appName}-rollbackLambdaRole`, {
      roleName: `iam-${appName}Rollback-${stageName}-cac1-01`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });

    rollbackLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
    rollbackLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "sts:AssumeRole",
        ],
        resources: [`arn:aws:iam::${accountId}:role/iam-${appName}Codedeploy-rollback-role`]
    }));
    
    // Lambda for CodeDeploy Rollback
    const rollbackLambda = new cdk.aws_lambda.Function(this, `${appName}-rollback-lambda`, {
      functionName: `lambda-${appName}RollBack-${stageName}-cac1-01`,
      role: rollbackLambdaRole,
      timeout: cdk.Duration.seconds(300),
      code: cdk.aws_lambda.Code.fromAsset(
        path.join(__dirname, 'lambdas'),
        {
          exclude: ['**', '!codedeploy_rollback.mjs']
        }),
      handler: 'codedeploy_rollback.handler',
      runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
      environment: {
        'CLUSTER_NAME': `${multiEcs.clusterName}`,
        'CODEDEPLOY_APP_NAME': `${multiEcs.codeDeployAppName}`,
        'CODEDEPLOY_GROUP_NAME': `${multiEcs.codeDeployGroupName}`,
        'WORKLOAD_ACCOUNT_ID': accountId,
        'APP_NAME': appName,
      }
    });

    // Event rule for pipeline manual approval rejection
    const pipelineRejectionRule = new cdk.aws_events.Rule(this, `${appName}-${stageName}-approval-state-change`, {
      ruleName: `event-${appName}ApprovalStateChange-${stageName}-${regionShort}-01`,
      eventPattern: {
        source: ["aws.codepipeline"],
        detailType: ["CodePipeline Action Execution State Change"],
        detail: {
          state: ['FAILED'],
          pipeline: [ecsPipeline.pipelineName],
          stage: ['Approval'],
          action: [approvalAction.actionProperties.actionName],
        },
      },
    });

    pipelineRejectionRule.addTarget(new cdk.aws_events_targets.LambdaFunction(rollbackLambda));

    // Event rule for pipeline CodeDeploy Stage Failure
    const pipelineCodeBuildRejectionRule = new cdk.aws_events.Rule(this, `${appName}-${stageName}-codedeploy-state-change`, {
      ruleName: `event-${appName}CodeDeployStateChange-${stageName}-${regionShort}-01`,
      eventPattern: {
        source: ["aws.codepipeline"],
        detailType: ["CodePipeline Action Execution State Change"],
        detail: {
          state: ['FAILED'],
          pipeline: [ecsPipeline.pipelineName],
          stage: ['CodeDeploy'],
          action: [codeDeployHelperAction.actionProperties.actionName],
        },
      },
    });

    pipelineCodeBuildRejectionRule.addTarget(new cdk.aws_events_targets.LambdaFunction(rollbackLambda));
  }
}
