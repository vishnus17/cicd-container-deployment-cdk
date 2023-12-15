import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import * as elb from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { EcsServiceAlarms } from "./alarms";
import * as path from 'path';
import { IFunction } from "aws-cdk-lib/aws-lambda";
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as efs from 'aws-cdk-lib/aws-efs';

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
  public readonly databaseName: string;

  constructor(scope: Construct, id: string, props?: containerFargateCdkStackProps /* props?: cdk.StackProps */) {
    super(scope, id, props);

    const regionShort = {
      'ap-south-1': 'aps1',
      'us-east-1': 'ue1',
      'us-east-2': 'ue2',
      'us-west-1': 'uw1',
      'us-west-2': 'uw2',
    }[this.region]

    // const appName = this.node.tryGetContext("appName");
    const appName = props ? props.appName : '';
    const vpcId = props ? props.vpcId : '';
    const stageName = props ? props.stageName : '';
    const privateSub1 = props ? props.privateSub1 : '';
    const privateSub2 = props ? props.privateSub2 : '';
    const privateSub3 = props ? props.privateSub3 : '';
    const pubSub1 = props ? props.pubSub1 : '';
    const pubSub2 = props ? props.pubSub2 : '';
    const pubSub3 = props ? props.pubSub3 : '';
    const desiredCount = props?.stageName === "prod" ? 10 : 2;

    const certificate = cdk.aws_ssm.StringParameter.valueForStringParameter(this, '/container/certificate'); // Enter your Certificate SSM store here

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

    const accessPoint = fileSystem.addAccessPoint('AccessPoint', {
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

    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      roleName: `role-${appName}ClusterAdmin`,
      assumedBy: new iam.AccountRootPrincipal()
    });

    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      vpc: vpc,
      clusterName: `cluster-${appName}-${stageName}-${regionShort}-01`
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: `logs-${appName}-${stageName}-${regionShort}-01`
    });
    
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
    
    

    /* Setup ALB, attach Port 443, 80 and blue/green target groups */
    const alb = new elb.ApplicationLoadBalancer(this, 'alb', {
      loadBalancerName: `alb-${appName}-${stageName}-${regionShort}-01`,
      vpc: vpc!,
      internetFacing: true
    });

    alb.addRedirect({
      sourceProtocol: elb.ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: elb.ApplicationProtocol.HTTPS,
      targetPort: 443
    })

    const cert = certificatemanager.Certificate.fromCertificateArn(this, 'containerALBcert', certificate);
    const albProdListener = alb.addListener('albProdListener', {
      port: 443,
      certificates: [cert]
    });

    const albTestListener = alb.addListener('albTestListener', {
      port: 8080
    });

    albProdListener.connections.allowDefaultPortFromAnyIpv4('Allow traffic from everywhere');
    albTestListener.connections.allowDefaultPortFromAnyIpv4('Allow traffic from everywhere');

    // Allow traffic from ALB to volume
    fileSystem.connections.allowDefaultPortFromAnyIpv4('Allow traffic from everywhere');

    const blueTargetGroup = new elb.ApplicationTargetGroup(this, 'blueGroup', {
      vpc: vpc!,
      targetGroupName: `TG-${appName}-${stageName}-${regionShort}-01`,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      targetType: elb.TargetType.IP,
      healthCheck: {
        path: '/',
        timeout: cdk.Duration.seconds(30),
        interval: cdk.Duration.seconds(60),
        healthyHttpCodes: '200'
      }
    });

    const greenTargetGroup = new elb.ApplicationTargetGroup(this, 'greenGroup', {
      vpc: vpc!,
      targetGroupName: `TG-${appName}-${stageName}-${regionShort}-02`,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      targetType: elb.TargetType.IP,
      healthCheck: {
        path: '/',
        timeout: cdk.Duration.seconds(30),
        interval: cdk.Duration.seconds(60),
        healthyHttpCodes: '200'
      }
    });

    albProdListener.addTargetGroups('blueTarget', {
      targetGroups: [blueTargetGroup]
    });

    albTestListener.addTargetGroups('greenTarget', {
      targetGroups: [greenTargetGroup]
    });


    /* Creating ECS service, roles, taskdef etc */
    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "ssm:*"
      ]
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
      taskRole: taskRole,
      family: `${appName}`
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    const initContainerRepo = ecr.Repository.fromRepositoryName(this, 'Repo', "init-container");
    const container = taskDef.addContainer(`${appName}`, {
      image: ecs.ContainerImage.fromEcrRepository(initContainerRepo), // fromRegistry("amazon/amazon-ecs-sample"),
      memoryLimitMiB: 256,
      cpu: 256,
      logging
    });

    container.addPortMappings({
      containerPort: 80,
      protocol: ecs.Protocol.TCP
    });

    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition: taskDef,
      serviceName: `ecs-${appName}-${stageName}-${regionShort}-01`,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      desiredCount: desiredCount,
      deploymentController: {
        type: ecs.DeploymentControllerType.CODE_DEPLOY
      },
    });

    // Uncomment after first deployment
    // const cfnService = service.node.defaultChild as ecs.CfnService;
    // cfnService.addOverride('Properties.TaskDefinition', service.taskDefinition.taskDefinitionArn);

    service.connections.allowFrom(alb, ec2.Port.tcp(80))
    service.connections.allowFrom(alb, ec2.Port.tcp(8080))
    service.attachToApplicationTargetGroup(blueTargetGroup);

    const importService = ecs.FargateService.fromFargateServiceAttributes(this, 'ImportFargateService', {
      serviceArn: service.serviceArn,
      cluster: cluster
    })

    // autoscaling is set to scale based on the cpu utilization
    const scaling = service.autoScaleTaskCount({ maxCapacity: props?.stageName === "prod" ? 100 : 6 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 80,
    });

    // create a deployer role. This is going to be used by cross-account (ops) account for deployment
    const deployerRole = new iam.Role(this, `${appName}-deployer-role`, {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("ec2.amazonaws.com"),
        new iam.AccountPrincipal("123123123"),
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

    // Export values
    this.serviceArn = this.formatArn({
      service: 'ecs',
      resource: 'service',
      resourceName: service.serviceName,
    });
    this.clusterName = cluster.clusterName;
    this.clusterArn = cluster.clusterArn;
    this.vpc = vpc;
    const deployArn = this.formatArn({
      service: 'iam',
      resource: 'role',
      resourceName: `role-${appName}ECSDeployerRole`,
      region: ''
    });

    this.deployRole = iam.Role.fromRoleArn(
      this,
      'DeployRole',
      deployArn
    );
    this.alb = alb.loadBalancerDnsName;

    /* CodeDeploy */
    const ecsApplication = new codedeploy.EcsApplication(this, 'ecsApplication', {
      applicationName: `codedeploy-${appName}-${stageName}-${regionShort}-01`
    });

    const codeDeployServiceRole = new iam.Role(this, 'ecsCodeDeployServiceRole', {
      roleName: `role-${appName}CodeDeployServiceRole`,
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com')
    });
    codeDeployServiceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployRoleForECS'));

    deployerRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployRoleForECS'));

    // IAM role for custom lambda function
    const customLambdaServiceRole = new iam.Role(this, 'codeDeployCustomLambda', {
      roleName: `role-${appName}CustomResource`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });

    const inlinePolicyForLambda = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole',
        'sts:AssumeRole',
        'codedeploy:List*',
        'codedeploy:Get*',
        'codedeploy:UpdateDeploymentGroup',
        'codedeploy:CreateDeploymentGroup',
        'codedeploy:DeleteDeploymentGroup'
      ],
      resources: ['*']
    });

    customLambdaServiceRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))
    customLambdaServiceRole.addToPolicy(inlinePolicyForLambda);

    // Custom resource to create the deployment group
    const createDeploymentGroupLambda = new lambda.Function(this, 'createDeploymentGroupLambda', {
      code: lambda.Code.fromAsset(
        path.join(__dirname, 'custom_resources'),
        {
          exclude: ['**', '!create_deployment_group.py']
        }),
      runtime: lambda.Runtime.PYTHON_3_8,
      functionName: `lambda-${appName}CreateCodeDeployGroup-${stageName}-${regionShort}-01`,
      handler: 'create_deployment_group.handler',
      role: customLambdaServiceRole,
      description: 'Custom resource to create ECS deployment group',
      memorySize: 128,
      timeout: cdk.Duration.seconds(60)
    });

    const deploymentConfigName = new cdk.CfnParameter(this, 'deploymentConfigName', {
      type: 'String',
      default: 'CodeDeployDefault.ECSAllAtOnce',
      allowedValues: [
        'CodeDeployDefault.ECSLinear10PercentEvery1Minutes',
        'CodeDeployDefault.ECSLinear10PercentEvery3Minutes',
        'CodeDeployDefault.ECSCanary10Percent5Minutes',
        'CodeDeployDefault.ECSCanary10Percent15Minutes',
        'CodeDeployDefault.ECSAllAtOnce'
      ],
      description: 'Shifts x percentage of traffic every x minutes until all traffic is shifted',
    });

    const taskSetTerminationTimeInMinutes = new cdk.CfnParameter(this, 'taskSetTerminationTimeInMinutes', {
      type: 'Number',
      default: '10',
      description: 'TaskSet termination time in minutes',
    });

    const ecsServiceAlarms = new EcsServiceAlarms(this, 'alarms', {
      alb: alb,
      blueTargetGroup: blueTargetGroup,
      greenTargetGroup: greenTargetGroup,
      apiName: `${appName}`
    });

    new cdk.CustomResource(this, 'customEcsDeploymentGroup', {
      serviceToken: createDeploymentGroupLambda.functionArn,
      properties: {
        ApplicationName: ecsApplication.applicationName,
        DeploymentGroupName: `DG-${appName}-${stageName}-${regionShort}-01`,
        DeploymentConfigName: deploymentConfigName.valueAsString,
        ServiceRoleArn: deployerRole.roleArn, //codeDeployServiceRole.roleArn,
        BlueTargetGroup: blueTargetGroup.targetGroupName,
        GreenTargetGroup: greenTargetGroup.targetGroupName,
        ProdListenerArn: albProdListener.listenerArn,
        TestListenerArn: albTestListener.listenerArn,
        TargetGroupAlarms: JSON.stringify(ecsServiceAlarms.targetGroupAlarms),
        EcsClusterName: cluster.clusterName,
        EcsServiceName: service.serviceName,
        TerminationWaitTime: taskSetTerminationTimeInMinutes.valueAsNumber,
        TrafficRouteTime: 240
      }
    });

    const ecsDeploymentGroup = codedeploy.EcsDeploymentGroup.fromEcsDeploymentGroupAttributes(this, 'ecsDeploymentGroup', {
      application: ecsApplication,
      deploymentGroupName: `DG-${appName}-${stageName}-${regionShort}-01`!,
      deploymentConfig: codedeploy.EcsDeploymentConfig.fromEcsDeploymentConfigName(this, 'ecsDeploymentConfig', deploymentConfigName.valueAsString!)
    });
    
    this.deploymentGroup = ecsDeploymentGroup;
    this.codeDeployGroupName = ecsDeploymentGroup.deploymentGroupName;
    this.codeDeployAppName = ecsApplication.applicationName;
  }
}