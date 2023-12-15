import * as cdk from 'aws-cdk-lib';
import { Duration, Stack, StackProps, StageProps, Stage } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { containerFargateCdkStack } from './container-fargate-cdk-stack';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";

export interface containerFargateCdkStageProps extends StageProps {
  stageName: string;
  vpcId: string;
  pubSub1: string;
  pubSub2: string;
  pubSub3: string;
  privateSub1: string;
  privateSub2: string;
  privateSub3: string;
  appName: string;
}

export class MultiAccountECS extends Stage {
  public readonly serviceArn: string;
  public readonly clusterName: string;
  public readonly deployRole: iam.IRole;
  public readonly vpc: IVpc;
  public readonly deploymentGroup: codedeploy.IEcsDeploymentGroup;
  public readonly clusterArn: string;
  public readonly createDeploymentLambdaArn: string;
  public readonly routeTrafficLambdaArn: string;
  public readonly codeDeployAppName: string;
  public readonly codeDeployGroupName: string;
  public readonly appName: string;
  public readonly alb: string;

  constructor(scope: Construct, id: string, props: containerFargateCdkStageProps /* props: cdk.StageProps */) {
    super(scope, id, props);

    const ecsStack = new containerFargateCdkStack(this, 'ecsStack', { appName: props.appName, stageName: props.stageName, vpcId: props.vpcId, pubSub1: props.pubSub1, pubSub2: props.pubSub2, pubSub3: props.pubSub3, privateSub1: props.privateSub1, privateSub2: props.privateSub2, privateSub3: props.privateSub3 });
    this.serviceArn = ecsStack.serviceArn;
    this.clusterName = ecsStack.clusterName;
    this.deployRole = ecsStack.deployRole;
    this.clusterArn = ecsStack.clusterArn;
    this.deploymentGroup = ecsStack.deploymentGroup;
    this.createDeploymentLambdaArn = ecsStack.createDeploymentLambdaArn;
    this.routeTrafficLambdaArn = ecsStack.routeTrafficLambdaArn;
    this.vpc = ecsStack.vpc;
    this.codeDeployGroupName = ecsStack.codeDeployGroupName;
    this.codeDeployAppName = ecsStack.codeDeployAppName;
    this.alb = ecsStack.alb;
  }
}