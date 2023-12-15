#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { containerFargateCdkStack } from '../lib/container-fargate-cdk-stack';
import { containerCICDCdkStack } from '../lib/container-cicd-cdk-stack';
import { containerBuildPipelineStack } from '../lib/container-build-pipeline-stack';
import { containerRoute53 } from '../lib/container-route53';

const app = new cdk.App();

/* ECR Build pipeline */
new containerBuildPipelineStack(app, 'containerBuildPipelineStack', {
  appName: 'container',
});

/* Fargate Stack */
new containerFargateCdkStack(app, 'containerSBXFargateCdkStack', {
  stageName: 'sbx',
  appName: 'container',
  vpcId: 'vpc-123123121212',
  pubSub1: 'subnet-123123121212',
  pubSub2: 'subnet-123123121212',
  pubSub3: 'subnet-123123121212',
  privateSub1: 'subnet-123123121212',
  privateSub2: 'subnet-123123121212',
  privateSub3: 'subnet-123123121212',
});

/* Pipeline Stack */
new containerCICDCdkStack(app, 'containerSBXCICDStack', {
  accountId: '123123123', // Enter workload account ID here
  appName: 'container',
  stageName: 'sbx',
  vpcId: 'vpc-123123121212',
  pubSub1: 'subnet-123123121212',
  pubSub2: 'subnet-123123121212',
  pubSub3: 'subnet-123123121212',
  privateSub1: 'subnet-123123121212',
  privateSub2: 'subnet-123123121212',
  privateSub3: 'subnet-123123121212',
  opsAccountId: '123123121212', // Enter
});

/* Route53 Stack */
new containerRoute53(app, 'containerRoute53Stack', {
  stageName: 'qa',
  albDNS : 'xyz.ap-south-1.elb.amazonaws.com',
});