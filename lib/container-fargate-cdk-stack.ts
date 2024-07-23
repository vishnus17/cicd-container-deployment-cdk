import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import { EcsServiceAlarms } from "./alarms";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

const ACCOUNTS = {
  OPS: "123123123", // Enter Operations account number
};
export interface containerFargateCdkStackProps extends StackProps {
  stageName: string;
  vpcId: string;
  privateSub1: string;
  privateSub2: string;
  privateSub3: string;
  pubSub1: string;
  pubSub2: string;
  pubSub3: string;
  appName: string;
}

export class containerFargateCdkStack extends Stack {
  public readonly serviceArn: string;
  public readonly clusterName: string;
  public readonly deployRole: iam.IRole;
  public readonly clusterArn: string;
  public readonly appName: string;
  public readonly vpc: IVpc;
  public readonly deploymentGroup: codedeploy.IEcsDeploymentGroup;
  public readonly createDeploymentLambdaArn: string;
  public readonly routeTrafficLambdaArn: string;
  public readonly routeTrafficLambda: IFunction;
  public readonly codeDeployAppName: string;
  public readonly codeDeployGroupName: string;
  public readonly alb: string;

  constructor(scope: Construct, id: string, props: containerFargateCdkStackProps) {
    super(scope, id, props);

    const regionShort = {
      'ap-south-1': 'aps1',
      'us-east-1': 'ue1',
      'us-east-2': 'ue2',
      'us-west-1': 'uw1',
      'us-west-2': 'uw2',
    }[this.region]

    const {
      appName,
      vpcId,
      stageName,
      privateSub1,
      privateSub2,
      privateSub3,
      pubSub1,
      pubSub2,
      pubSub3,
    } = props;

    // vpc for the cluster
    const vpc = ec2.Vpc.fromVpcAttributes(this, "VPC", {
      vpcId: vpcId,
      publicSubnetIds: [
        pubSub1,
        pubSub2,
        pubSub3
      ],
      privateSubnetIds: [
        privateSub1,
        privateSub2,
        privateSub3
      ],
      availabilityZones: [
        'ap-south-1a',
        'ap-south-1b',
        'ap-south-1d'
      ]
    })

    // EFS volume
    const volumeName = `efs-${appName}-${stageName}-${regionShort}-01`;
    const volumePath = '/mnt/efs';

    const fileSystem = new efs.FileSystem(this, 'EfsFileSystem', {
      vpc: vpc,
      fileSystemName: volumeName,
      encrypted: true,
      // lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    fileSystem.addAccessPoint('AccessPoint', {
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755'
      },
      path: volumePath,
      posixUser: {
        gid: '1000',
        uid: '1000'
      }
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      vpc: vpc,
      clusterName: `cluster-${appName}-${stageName}-${regionShort}-01`
    });

    // Log group
    const logGroup = new logs.LogGroup(this, 'logGroup', {
      logGroupName: `/aws/ecs/${appName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: `logs-${appName}-${stageName}-${regionShort}-01`,
      logGroup: logGroup
    });
    
    // ECS Task Role
    const taskRole = new iam.Role(this, `ecs-taskRole-${appName}`, {
      roleName: `role-${appName}EcsTaskRole`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    })

    taskRole.addToPolicy(
      new PolicyStatement(
        {
          resources: ['*'],
          actions: [
            "ssm:*",
            "s3:*"
          ],
        }
      )
    );

    // ECS Task Execution Role
    const taskExecutionRole = new iam.Role(this, `ecs-taskExecutionRole-${appName}`, {
      roleName: `role-${appName}EcsTaskExecutionRole`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    })

    taskExecutionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        'kms:Decrypt',
      ]
    }));

    // Load balancer
    const alb = new elb.ApplicationLoadBalancer(this, 'alb', {
      loadBalancerName: `alb-${appName}-${stageName}-${regionShort}-01`,
      vpc: vpc!,
      internetFacing: true
    });

    const certificate = ssm.StringParameter.valueForStringParameter(this, `/${appName}/certificate`); // Enter your Certificate SSM store here
    const cert = certificatemanager.Certificate.fromCertificateArn(this, 'containerCert', certificate);

    // Prod Listener
    const albProdListener = alb.addListener('albProdListener', {
      port: 443,
      certificates: [cert]
    });

    alb.addRedirect({
      sourceProtocol: elb.ApplicationProtocol.HTTP,
      sourcePort: 8443,
      targetProtocol: elb.ApplicationProtocol.HTTPS,
      targetPort: 443
    });

    // Test Listener for health check
    const albTestListener = alb.addListener('albTestListener', {
      port: 8080,
    });

    albProdListener.connections.allowDefaultPortFromAnyIpv4('Allow traffic from everywhere');
    albTestListener.connections.allowDefaultPortFromAnyIpv4('Allow traffic from everywhere');

    // Target groups
    const blueTargetGroup = new elb.ApplicationTargetGroup(this, 'blueGroup', {
      vpc: vpc!,
      targetGroupName: `TG-${appName}-${stageName}-${regionShort}-01`,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 8443,
      targetType: elb.TargetType.IP,
      healthCheck: {
        path: '/',
        timeout: cdk.Duration.seconds(30),
        interval: cdk.Duration.seconds(60),
        healthyHttpCodes: '200',
        port: '8080' // health check port
      }
    });

    const greenTargetGroup = new elb.ApplicationTargetGroup(this, 'greenGroup', {
      vpc: vpc!,
      targetGroupName: `TG-${appName}-${stageName}-${regionShort}-02`,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 8443,
      targetType: elb.TargetType.IP,
      healthCheck: {
        path: '/',
        timeout: cdk.Duration.seconds(30),
        interval: cdk.Duration.seconds(60),
        healthyHttpCodes: '200',
        port: '8080' // health check port
      }
    });

    albProdListener.addTargetGroups('blueTarget', {
      targetGroups: [blueTargetGroup]
    });

    albTestListener.addTargetGroups('greenTarget', {
      targetGroups: [greenTargetGroup]
    });

    // ECS Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
      taskRole: taskRole,
      family: `${appName}`,
      executionRole: taskExecutionRole
    });

    // Init container
    taskDef.addContainer(`${appName}`, {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/bitnami/nginx:latest'),
      memoryLimitMiB: 256,
      cpu: 256,
      logging,
      portMappings: [
        {
          containerPort: 8080,
          hostPort: 8080
        }
      ]
    });

    // Set the number of desired tasks based on the stage
    const desiredCount = props?.stageName === "prod" ? 2 : 1;
    
    // ECS service
    const ecsService = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition: taskDef,
      serviceName: `ecs-${appName}-${stageName}-${regionShort}-01`,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      desiredCount: desiredCount,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY
      },
    });

    // const cfnService = service.node.defaultChild as ecs.CfnService;
    // cfnService.addOverride('Properties.TaskDefinition', service.taskDefinition.taskDefinitionArn);

    // Allow traffic from ALB to ECS service
    ecsService.connections.allowFrom(alb, ec2.Port.tcp(8443))
    ecsService.connections.allowFrom(alb, ec2.Port.tcp(80))
    ecsService.connections.allowFrom(alb, ec2.Port.tcp(8080))

    // Add the ECS service as a target to the ALB
    ecsService.attachToApplicationTargetGroup(blueTargetGroup);

    // autoscaling is set to scale based on the cpu utilization
    const scaling = ecsService.autoScaleTaskCount({ maxCapacity: props?.stageName === "prod" ? 100 : 6 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 80,
    });

    // create a deployer role. This is going to be used by cross-account (ops) account for deployment
    const deployerRole = new iam.Role(this, `${appName}-deployer-role`, {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("ec2.amazonaws.com"),
        new iam.AccountPrincipal(`${ACCOUNTS.OPS}`), // Enter Operations account number
        new iam.ServicePrincipal('codedeploy.amazonaws.com')
      ),
      roleName: `role-${appName}ECSDeployerRole`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployRoleForECS'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECS_FullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationFullAccess')
      ]
    })

    // Code Deployer access
    deployerRole.addToPolicy(
      new PolicyStatement(
        {
          resources: ['*'],
          actions: [
            "codedeploy:CreateDeployment",
            "codedeploy:GetDeployment",
            "codedeploy:GetDeploymentConfig",
            "codedeploy:GetApplicationRevision",
            "codedeploy:RegisterApplicationRevision"
          ],
        }
      )
    );

    // Cross-account S3 access
    deployerRole.addToPolicy(
      new PolicyStatement(
        {
          resources: [
            `arn:aws:s3:::artifact-bucket-${appName}`,
            `arn:aws:s3:::artifact-bucket-${appName}/*`
          ],
          actions: [
            's3:ListBucket',
            's3:Get*',
            "s3:GetObject*",
            "s3:PutObject",
            "s3:PutObjectAcl",
            "codecommit:ListBranches",
            "codecommit:ListRepositories"
          ]
        }
      )
    );

    // cross account KMS access
    deployerRole.addToPolicy(
      new PolicyStatement(
        {
          resources: [
            '*'
          ],
          actions: [
            "kms:DescribeKey",
            "kms:GenerateDataKey*",
            "kms:Encrypt",
            "kms:ReEncrypt*",
            "kms:Decrypt"
          ]
        }
      )
    );

    deployerRole.addToPolicy(
      new PolicyStatement(
        {
          resources: [
            `arn:aws:ssm:${this.region}:${this.account}:parameter/${appName}/DeploymentId`
          ],
          actions: [
            "ssm:*"
          ]
        }
      )
    );

    // IAM role for CodeDeploy rollback -- Assumed by Ops account Lambda for Rollback
    const rollbackRole = new iam.Role(this, 'RollbackRole', {
      roleName: `iam-${appName}Codedeploy-rollback-role`,
      description: 'IAM role for CodeDeploy rollback',
      assumedBy: new iam.ArnPrincipal(
        `arn:aws:iam::${ACCOUNTS.OPS}:role/iam-${appName}Rollback-${stageName}-cac1-01`,
      )
    });
    
    rollbackRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'codedeploy:*'
      ],
      resources: [
        `arn:aws:codedeploy:*:*:application:codedeploy-${appName}-*`,
        `arn:aws:codedeploy:*:*:deploymentgroup:codedeploy-${appName}-*`,
        `arn:aws:codedeploy:*:*:deploymentconfig:*`
      ],
    }));

    rollbackRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:GetParameter'
      ],
      resources: [
        `arn:aws:ssm:*:*:parameter/${appName}/DeploymentId`,
      ],
    }));

    /* CodeDeploy */
    const ecsApplication = new codedeploy.EcsApplication(this, 'ecsApplication', {
      applicationName: `codedeploy-${appName}-${stageName}-${regionShort}-01`
    });

    deployerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployRoleForECS'));

    // ECS service alarms
    const ecsServiceAlarms = new EcsServiceAlarms(this, 'alarms', {
      alb: alb,
      blueTargetGroup: blueTargetGroup,
      greenTargetGroup: greenTargetGroup,
      apiName: `${appName}`
    });
    
    const unhealthyHostAlarmBlueTG = cdk.aws_cloudwatch.Alarm.fromAlarmName(this, 'unhealthyHostAlarmBlueTG',
      ecsServiceAlarms.targetGroupAlarms![0].name
    );

    const fivexxAlarmBlueTG = cdk.aws_cloudwatch.Alarm.fromAlarmName(this, 'fivexxAlarmBlueTG',
      ecsServiceAlarms.targetGroupAlarms![1].name
    );

    const unhealthyHostAlarmGreenTG = cdk.aws_cloudwatch.Alarm.fromAlarmName(this, 'unhealthyHostAlarmGreenTG',
      ecsServiceAlarms.targetGroupAlarms![2].name
    );

    const fivexxAlarmGreenTG = cdk.aws_cloudwatch.Alarm.fromAlarmName(this, 'fivexxAlarmGreenTG',
      ecsServiceAlarms.targetGroupAlarms![3].name
    );

    // CodeDeploy deployment group
    const ecsDeploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'ecsDeploymentGroup', {
      service: ecsService,
      application: ecsApplication,
      deploymentGroupName: `DG-${appName}-${stageName}-${regionShort}-01`,
      blueGreenDeploymentConfig: {
        blueTargetGroup: blueTargetGroup,
        greenTargetGroup: greenTargetGroup,
        listener: albProdListener,
        testListener: albTestListener,
        deploymentApprovalWaitTime: cdk.Duration.minutes(15),
        terminationWaitTime: cdk.Duration.minutes(10),
      },
      role: deployerRole,
      alarms: [ unhealthyHostAlarmBlueTG, fivexxAlarmBlueTG, unhealthyHostAlarmGreenTG, fivexxAlarmGreenTG ],
      autoRollback: {
        failedDeployment: true,
        deploymentInAlarm: true
      }
    });

    // SSM Parameter for ALB endpoint
    new ssm.StringParameter(this, 'albEndpoint', {
      parameterName: `/${appName}/endpoint`,
      stringValue: alb.loadBalancerDnsName
    });

    // Export values
    this.serviceArn = this.formatArn({
      service: 'ecs',
      resource: 'service',
      resourceName: ecsService.serviceName,
    });

    const deployArn = this.formatArn({
      service: 'iam',
      resource: 'role',
      resourceName: `role-${appName}ECSDeployerRole`,
      region: ''
    });

    this.deployRole = iam.Role.fromRoleArn( this, 'DeployRole',
      deployArn
    );
    
    this.clusterName = cluster.clusterName;
    this.clusterArn = cluster.clusterArn;
    this.vpc = vpc;
    this.alb = alb.loadBalancerDnsName;
    this.deploymentGroup = ecsDeploymentGroup;
    this.codeDeployGroupName = ecsDeploymentGroup.deploymentGroupName;
    this.codeDeployAppName = ecsApplication.applicationName;
  }
}